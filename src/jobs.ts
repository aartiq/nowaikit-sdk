// nowaikit-sdk/jobs: follow NowAIKit background jobs.
//
// Long-running NowAIKit MCP tools (ATF runs, discovery, transforms, fluent builds and so on) return a
// job handle when called with `async: true` or when they run past about 20 seconds. The handle is
// polled with the `get_job` tool. These helpers work with any MCP client: pass a function that calls
// a NowAIKit tool and returns its result.

import { ServiceNowError } from './errors.js';

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** What `get_job` returns (NowAIKit 5.0). */
export interface JobView {
  job_id: string;
  tool: string;
  status: JobStatus;
  progress?: { percent?: number; message?: string };
  elapsed_seconds?: number;
  created_at?: string;
  updated_at?: string;
  finished_at?: string;
  expires_at?: string;
  poll_with?: string;
  poll_after_seconds?: number;
  /** The tool's result, once status is completed. */
  result?: unknown;
  error?: { message: string; code?: string };
  servicenow_cancelled?: boolean;
  [key: string]: unknown;
}

/**
 * Calls a NowAIKit tool. It may return the parsed tool output, or a raw MCP CallToolResult
 * ({ content: [{ type: 'text', text }], structuredContent }); both are understood.
 */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface WaitForJobOptions {
  /** Pause between polls when the server does not hold the request (default 2000 ms). */
  intervalMs?: number;
  /** Give up after this long (default 10 minutes). The job keeps running on the server. */
  timeoutMs?: number;
  /** Seconds get_job may hold each poll open waiting for completion (0 to 25, default 20). */
  waitSeconds?: number;
  /** Called after every poll. */
  onProgress?: (job: JobView) => void;
  signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalJobStatus(status: string | undefined): boolean {
  return !!status && TERMINAL.has(status);
}

/** Turn a tool return value (parsed object or MCP CallToolResult) into a plain object. */
export function parseToolOutput(out: unknown): any {
  if (!out || typeof out !== 'object') {
    if (typeof out === 'string') {
      try { return JSON.parse(out); } catch { return out; }
    }
    return out;
  }
  const r = out as Record<string, any>;
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  if (Array.isArray(r.content)) {
    const text = r.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('');
    if (r.isError) throw new ServiceNowError(text || 'Tool call failed', 'TOOL_ERROR');
    try { return JSON.parse(text); } catch { return text; }
  }
  return r;
}

/** True when a tool result is a job handle (the tool switched to running in the background). */
export function isJobHandle(out: unknown): out is JobView {
  let v: any;
  try { v = parseToolOutput(out); } catch { return false; }
  return !!v && typeof v === 'object' && typeof v.job_id === 'string' && typeof v.status === 'string';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
  });
}

/**
 * Poll `get_job` until the job completes, fails or is cancelled. Returns the final job view (its
 * `result` holds the tool output when completed). Throws on timeout; the job itself keeps running.
 */
export async function waitForJob(callTool: ToolCaller, jobId: string, options: WaitForJobOptions = {}): Promise<JobView> {
  if (!jobId) throw new ServiceNowError('jobId is required', 'VALIDATION_ERROR');
  const intervalMs = Math.max(options.intervalMs ?? 2000, 0);
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const waitSeconds = Math.min(Math.max(options.waitSeconds ?? 20, 0), 25);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted');
    const left = deadline - Date.now();
    const wait = Math.max(0, Math.min(waitSeconds, Math.floor(left / 1000)));
    const job = parseToolOutput(await callTool('get_job', wait ? { job_id: jobId, wait_seconds: wait } : { job_id: jobId })) as JobView;
    if (!job || typeof job !== 'object' || !job.status) {
      throw new ServiceNowError(`get_job returned an unexpected result for ${jobId}`, 'TOOL_ERROR');
    }
    options.onProgress?.(job);
    if (isTerminalJobStatus(job.status)) return job;
    if (Date.now() >= deadline) {
      throw new ServiceNowError(`Job ${jobId} is still running after ${Math.round(timeoutMs / 1000)}s. Poll it again later with get_job.`, 'JOB_TIMEOUT');
    }
    await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)), options.signal);
  }
}

/**
 * Call a long-running tool and return its final result. If the tool hands back a job, this waits for
 * it with waitForJob and returns the job's result, or throws with the job's error.
 */
export async function callToolAndWait(
  callTool: ToolCaller,
  name: string,
  args: Record<string, unknown> = {},
  options: WaitForJobOptions & { async?: boolean } = {},
): Promise<unknown> {
  const first = await callTool(name, options.async ? { ...args, async: true } : args);
  if (!isJobHandle(first)) return parseToolOutput(first);
  const handle = parseToolOutput(first) as JobView;
  const job = isTerminalJobStatus(handle.status) ? handle : await waitForJob(callTool, handle.job_id, options);
  if (job.status === 'completed') return job.result;
  throw new ServiceNowError(job.error?.message || `Job ${job.job_id} ${job.status}`, job.status === 'cancelled' ? 'JOB_CANCELLED' : (job.error?.code || 'JOB_FAILED'));
}
