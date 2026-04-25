import type { BatchRequestItem, BatchResponseItem } from './types.js';
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
export declare function buildBatchPayload(requests: BatchRequestItem[], batchRequestId?: string): {
    rest_requests: Array<{
        id: string;
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
    }>;
};
/**
 * Parse a batch response from ServiceNow.
 * Maps each sub-response to a structured BatchResponseItem.
 */
export declare function parseBatchResponse(raw: any): BatchResponseItem[];
//# sourceMappingURL=batch.d.ts.map