import type { BatchRequestItem, BatchResponseItem, BatchResponse } from './types.js';
import { ServiceNowError } from './errors.js';

/**
 * Build a batch request payload for ServiceNow's /api/now/v1/batch endpoint.
 * Reduces round-trips by sending multiple operations in a single HTTP call.
 *
 * Usage:
 *   const results = await client.batch([
 *     { method: 'GET', url: '/api/now/table/incident?sysparm_limit=5' },
 *     { method: 'GET', url: '/api/now/stats/incident?sysparm_count=true' },
 *   ]);
 */
export function buildBatchPayload(
  requests: BatchRequestItem[],
  batchRequestId?: string
): { rest_requests: Array<{ id: string; method: string; url: string; headers?: Record<string, string>; body?: string }> } {
  if (requests.length === 0) {
    throw new ServiceNowError('Batch request must contain at least one request', 'VALIDATION_ERROR');
  }
  if (requests.length > 50) {
    throw new ServiceNowError('Batch request cannot exceed 50 operations', 'VALIDATION_ERROR');
  }

  const batchId = batchRequestId || `batch_${Date.now()}`;

  return {
    rest_requests: requests.map((req, idx) => ({
      id: req.id || `${batchId}_${idx}`,
      method: req.method,
      url: req.url,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    })),
  };
}

/**
 * Parse a batch response from ServiceNow.
 * Maps each sub-response to a structured BatchResponseItem.
 */
export function parseBatchResponse(raw: any): BatchResponseItem[] {
  if (!raw || !raw.serviced_requests) {
    throw new ServiceNowError('Invalid batch response: missing serviced_requests', 'API_ERROR');
  }

  const response = raw as BatchResponse;

  return response.serviced_requests.map(item => ({
    id: item.id,
    status_code: item.status_code,
    headers: item.headers,
    body: typeof item.body === 'string' ? safeParseJson(item.body) : item.body,
    error: item.status_code >= 400 ? extractError(item.body) : undefined,
  }));
}

function safeParseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractError(body: unknown): string | undefined {
  if (!body) return undefined;
  const obj = typeof body === 'string' ? safeParseJson(body) : body;
  if (typeof obj === 'object' && obj !== null && 'error' in obj) {
    const err = (obj as { error: { message?: string } }).error;
    return err?.message || 'Unknown error';
  }
  return undefined;
}
