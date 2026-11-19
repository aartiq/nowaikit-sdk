// nowaikit-sdk/action-fabric: work with the instance's own MCP servers (MCP Server Console) and
// call ServiceNow AI agents over A2A (v0.3).
//
// ServiceNow's MCP and A2A endpoints only accept JWT access tokens from an OAuth authorization-code
// (+PKCE) sign-in. Registry reads and agent cards work with any auth the client already has.
// Zero dependencies: the MCP client below speaks Streamable HTTP with plain fetch.

import type { ServiceNowClient } from './client.js';
import { ServiceNowError } from './errors.js';

const SYS_ID = /^[0-9a-f]{32}$/i;
const SERVER_NAME = /^[a-z0-9_.-]{1,100}$/i;

/** MCP protocol version sent at initialize. ServiceNow's servers speak the 2025 handshake. */
export const SN_MCP_PROTOCOL_VERSION = '2025-06-18';

function val(r: any, f: string): string {
  const v = r?.[f];
  if (v && typeof v === 'object') return String(v.value ?? '');
  return v === undefined || v === null ? '' : String(v);
}

/** URL path segment for a registry record name (sn_mcp_server.default becomes sn_mcp_server_default). */
export function mcpEndpointName(name: string): string {
  return name.replace(/\./g, '_');
}

/** Full Streamable HTTP endpoint for a ServiceNow MCP server. */
export function mcpServerUrl(instanceUrl: string, server: string): string {
  if (!SERVER_NAME.test(server)) {
    throw new ServiceNowError('server must be an MCP server name, e.g. sn_mcp_server_default', 'VALIDATION_ERROR');
  }
  return `${instanceUrl.replace(/\/$/, '')}/sncapps/mcp-server/mcp/${mcpEndpointName(server)}`;
}

/** True when a token looks like a JWT (three base64url segments). */
export function isJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

function requireJwt(token: string, what: string): string {
  const t = (token || '').replace(/^Bearer\s+/i, '').trim();
  if (!t) throw new ServiceNowError(`${what} needs an OAuth (JWT) access token.`, 'AUTH_OAUTH_REQUIRED');
  if (!isJwt(t)) {
    throw new ServiceNowError(
      `${what} only accepts JWT access tokens. Set Token Format to JWT on your OAuth app in the Application Registry and sign in again.`,
      'AUTH_JWT_REQUIRED',
    );
  }
  return t;
}

// ─── MCP server registry ──────────────────────────────────────────────────────

export interface SnMcpServerTool {
  sys_id?: string;
  name?: string;
  /** Tool kind from the definition class, e.g. "skill", "subflow", "action". */
  type?: string;
}

export interface SnMcpServer {
  sys_id: string;
  name: string;
  label: string;
  status: string;
  description: string;
  endpoint: string;
  tools: SnMcpServerTool[];
}

export interface ListMcpServersOptions {
  status?: 'active' | 'draft' | 'inactive';
}

/** List the MCP servers defined in the instance's MCP Server Console registry, with their attached tools. */
export async function listMcpServers(client: ServiceNowClient, options: ListMcpServersOptions = {}): Promise<SnMcpServer[]> {
  const status = options.status ? options.status.replace(/[^a-z]/gi, '') : '';
  const reg = await client.queryRecords({
    table: 'sn_mcp_server_registry',
    query: status ? `status=${status}` : undefined,
    fields: 'sys_id,name,label,status,tools,description',
    limit: 100,
  });
  const base = client.getBaseUrl();
  const rows = (reg.records as any[]).map((r) => ({
    sys_id: val(r, 'sys_id'),
    name: val(r, 'name'),
    label: val(r, 'label'),
    status: val(r, 'status'),
    description: val(r, 'description'),
    endpoint: `${base}/sncapps/mcp-server/mcp/${mcpEndpointName(val(r, 'name'))}`,
    toolIds: val(r, 'tools') ? val(r, 'tools').split(',').filter(Boolean) : [],
  }));
  const ids = [...new Set(rows.flatMap((s) => s.toolIds))];
  let byId: Record<string, SnMcpServerTool> = {};
  if (ids.length) {
    const tools = await client.queryRecords({
      table: 'sn_mcp_tool_definition',
      query: `sys_idIN${ids.join(',')}`,
      fields: 'sys_id,name,sys_class_name',
      limit: Math.min(ids.length, 1000),
    });
    byId = Object.fromEntries((tools.records as any[]).map((t) => [
      val(t, 'sys_id'),
      { sys_id: val(t, 'sys_id'), name: val(t, 'name'), type: val(t, 'sys_class_name').replace(/^sn_mcp_|_tool_definition$/g, '') },
    ]));
  }
  return rows.map(({ toolIds, ...s }) => ({ ...s, tools: toolIds.map((id) => byId[id] || { sys_id: id }) }));
}

// ─── MCP client (Streamable HTTP) ─────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ServiceNowMcpClientConfig {
  /** Instance base URL, e.g. https://dev12345.service-now.com */
  instanceUrl: string;
  /** Server name from the registry, e.g. sn_mcp_server_default (dots are accepted). */
  server: string;
  /** JWT access token from an OAuth authorization-code sign-in. */
  bearerToken: string;
  clientInfo?: { name: string; version: string };
  timeoutMs?: number;
}

/** Read one JSON-RPC response from a JSON or text/event-stream body. */
async function readRpc(response: Response, id: number | string): Promise<any> {
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === id) return msg;
      } catch { /* skip keep-alives and partial events */ }
    }
    throw new ServiceNowError('MCP server closed the stream without a response', 'MCP_CALL_FAILED');
  }
  if (!text) return undefined;
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.find((m) => m?.id === id);
  return parsed;
}

/**
 * Minimal MCP client for a ServiceNow MCP server. Call `connect()` once (initialize handshake), then
 * `listTools()` / `callTool()`; `close()` ends the session.
 */
export class ServiceNowMcpClient {
  readonly url: string;
  private token: string;
  private clientInfo: { name: string; version: string };
  private timeoutMs: number;
  private sessionId?: string;
  private protocolVersion = SN_MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private connected = false;

  constructor(config: ServiceNowMcpClientConfig) {
    this.url = mcpServerUrl(config.instanceUrl, config.server);
    this.token = requireJwt(config.bearerToken, 'ServiceNow MCP servers');
    this.clientInfo = config.clientInfo || { name: 'nowaikit-sdk', version: '2.2.0' };
    this.timeoutMs = config.timeoutMs || 60000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.token}`,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.connected) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ServiceNowError(`The instance rejected the token for ${this.url} (HTTP 401). Sign in again for a fresh JWT.`, 'AUTHENTICATION_FAILED');
      }
      if (response.status === 404) {
        throw new ServiceNowError(`MCP server not found or inactive at ${this.url}`, 'NOT_FOUND');
      }
      throw new ServiceNowError(`MCP request failed: HTTP ${response.status} ${text.slice(0, 200)}`, 'MCP_CALL_FAILED');
    }
    const sid = response.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return response;
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    const msg = await readRpc(response, id);
    if (!msg) throw new ServiceNowError(`No response to ${method}`, 'MCP_CALL_FAILED');
    if (msg.error) throw new ServiceNowError(`MCP ${method} error: ${msg.error.message || JSON.stringify(msg.error)}`, 'MCP_CALL_FAILED');
    return msg.result as T;
  }

  /** Run the initialize handshake. Returns the server's initialize result. */
  async connect(): Promise<{ protocolVersion: string; serverInfo?: { name: string; version?: string }; capabilities?: Record<string, unknown> }> {
    const result = await this.rpc<any>('initialize', {
      protocolVersion: SN_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (result?.protocolVersion) this.protocolVersion = String(result.protocolVersion);
    this.connected = true;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  /** tools/list, following pagination cursors. */
  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureConnected();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.rpc<{ tools: McpToolInfo[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...(res?.tools || []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** tools/call. Tool errors come back as a result with isError: true, as MCP defines. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallToolResult> {
    await this.ensureConnected();
    return this.rpc<McpCallToolResult>('tools/call', { name, arguments: args });
  }

  /** End the session (best effort). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(10000) });
    } catch { /* ignore */ }
    this.sessionId = undefined;
    this.connected = false;
  }
}

/** One-shot: connect to a ServiceNow MCP server, list its tools, and close. */
export async function listServiceNowMcpTools(config: ServiceNowMcpClientConfig): Promise<McpToolInfo[]> {
  const mcp = new ServiceNowMcpClient(config);
  try {
    return await mcp.listTools();
  } finally {
    await mcp.close();
  }
}

/** One-shot: connect to a ServiceNow MCP server, call one tool, and close. */
export async function callServiceNowMcpTool(
  config: ServiceNowMcpClientConfig,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpCallToolResult> {
  const mcp = new ServiceNowMcpClient(config);
  try {
    return await mcp.callTool(tool, args);
  } finally {
    await mcp.close();
  }
}

// ─── A2A (ServiceNow AI agents) ───────────────────────────────────────────────

export interface SnAgentSummary {
  sys_id: string;
  name: string;
  description: string;
  a2a_exposed: boolean;
  agent_card_url: string;
}

/** A2A v0.3 agent card, as ServiceNow publishes it. */
export interface SnAgentCard {
  name: string;
  description?: string;
  url?: string;
  version?: string;
  protocolVersion?: string;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  capabilities?: Record<string, unknown>;
  skills?: Array<{ id: string; name: string; description?: string; tags?: string[] }>;
  [key: string]: unknown;
}

export type A2AV3Part =
  | { kind: 'text'; text: string }
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'file'; file: Record<string, unknown> };

export interface A2AV3Message {
  kind: 'message';
  role: 'user' | 'agent';
  messageId: string;
  parts: A2AV3Part[];
  contextId?: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface A2AV3Task {
  kind: 'task';
  id: string;
  contextId?: string;
  status: { state: string; message?: A2AV3Message; timestamp?: string };
  artifacts?: Array<{ artifactId?: string; parts: A2AV3Part[] }>;
  [key: string]: unknown;
}

export interface SendAgentMessageOptions {
  /** JWT access token with the a2aauthscope scope. */
  bearerToken: string;
  contextId?: string;
  taskId?: string;
  /** Wait for the agent to finish in the same call (default true). */
  blocking?: boolean;
  /** Overrides the output modes; by default they come from the agent card. */
  acceptedOutputModes?: string[];
}

export interface SendAgentMessageResult {
  /** Plain text of the agent's reply (message parts, or the task's status message and artifacts). */
  reply: string;
  state: string;
  taskId?: string;
  contextId?: string;
  raw: A2AV3Message | A2AV3Task;
}

/** List ServiceNow AI agents and whether each is open to third-party (A2A) callers. */
export async function listAiAgents(
  client: ServiceNowClient,
  options: { search?: string; exposedOnly?: boolean; limit?: number } = {},
): Promise<SnAgentSummary[]> {
  const limit = Math.min(Math.max(options.limit || 25, 1), 200);
  const search = options.search ? options.search.replace(/[\^\n]/g, ' ') : '';
  const agents = await client.queryRecords({
    table: 'sn_aia_agent',
    query: search ? `nameLIKE${search}^ORDERBYname` : 'ORDERBYname',
    fields: 'sys_id,name,description',
    limit: 500,
  });
  let exposed = new Set<string>();
  let inactive = new Set<string>();
  try {
    const cfg = await client.queryRecords({ table: 'sn_aia_agent_config', fields: 'agent,public,active', limit: 1000 });
    exposed = new Set((cfg.records as any[]).filter((r) => val(r, 'public') === 'true').map((r) => val(r, 'agent')));
    inactive = new Set((cfg.records as any[]).filter((r) => val(r, 'active') === 'false').map((r) => val(r, 'agent')));
  } catch { /* config table restricted: exposure reported as false */ }
  const base = client.getBaseUrl();
  return (agents.records as any[])
    .filter((a) => !inactive.has(val(a, 'sys_id')))
    .map((a) => ({
      sys_id: val(a, 'sys_id'),
      name: val(a, 'name'),
      description: val(a, 'description'),
      a2a_exposed: exposed.has(val(a, 'sys_id')),
      agent_card_url: `${base}/api/sn_aia/a2a/v2/agent_card/id/${val(a, 'sys_id')}`,
    }))
    .filter((a) => !options.exposedOnly || a.a2a_exposed)
    .slice(0, limit);
}

function assertSysId(id: string, what: string): string {
  if (!SYS_ID.test(id || '')) throw new ServiceNowError(`${what} must be a 32-character sys_id`, 'VALIDATION_ERROR');
  return id;
}

/** Fetch the A2A agent card of a ServiceNow AI agent. Works with the client's normal auth. */
export async function getAgentCard(client: ServiceNowClient, agentSysId: string): Promise<SnAgentCard> {
  assertSysId(agentSysId, 'agentSysId');
  try {
    const body = await client.apiRequest<any>(`${client.getBaseUrl()}/api/sn_aia/a2a/v2/agent_card/id/${agentSysId}`, { method: 'GET' });
    return (body?.result ?? body) as SnAgentCard;
  } catch (e) {
    if (/no agent available/i.test((e as Error).message)) {
      throw new ServiceNowError('This agent is not exposed to A2A. Allow third-party access for it in AI Agent Studio.', 'NOT_EXPOSED');
    }
    throw e;
  }
}

function partsText(parts: A2AV3Part[] | undefined): string {
  return (parts || [])
    .map((p: any) => p?.text ?? (p?.kind === 'data' ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n');
}

/** Plain text from an A2A reply, whether it is a message or a task. */
export function a2aReplyText(result: A2AV3Message | A2AV3Task): string {
  if ((result as A2AV3Task)?.kind === 'task' || (result as A2AV3Task)?.status) {
    const t = result as A2AV3Task;
    return partsText(t.status?.message?.parts) || (t.artifacts || []).map((a) => partsText(a.parts)).filter(Boolean).join('\n');
  }
  return partsText((result as A2AV3Message)?.parts);
}

function newMessageId(): string {
  return `nowaikit-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function a2aError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/a2aauthscope/i.test(msg)) {
    throw new ServiceNowError('A2A calls need an OAuth token with the a2aauthscope scope. Add that auth scope to your OAuth app and sign in again.', 'AUTH_SCOPE_REQUIRED');
  }
  if (/push notification url is required/i.test(msg)) {
    throw new ServiceNowError('The instance runs external A2A calls asynchronously. Set AI Agent Studio > Settings > External AI agents > Communication mode to Synchronous.', 'A2A_ASYNC_MODE');
  }
  throw e;
}

/**
 * Send a text message to a ServiceNow AI agent (A2A v0.3 `message/send` on
 * /api/sn_aia/a2a/v2/agent/id/{id}). acceptedOutputModes are taken from the agent card, because
 * ServiceNow validates them against it.
 */
export async function sendAgentMessage(
  client: ServiceNowClient,
  agentSysId: string,
  text: string,
  options: SendAgentMessageOptions,
): Promise<SendAgentMessageResult> {
  assertSysId(agentSysId, 'agentSysId');
  if (!text || !text.trim()) throw new ServiceNowError('text is required', 'VALIDATION_ERROR');
  const token = requireJwt(options.bearerToken, 'ServiceNow A2A agents');
  let outputModes = options.acceptedOutputModes;
  if (!outputModes?.length) {
    const card = await getAgentCard(client, agentSysId);
    outputModes = Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.length ? card.defaultOutputModes.map(String) : ['text/plain'];
  }
  const message: A2AV3Message = { kind: 'message', role: 'user', messageId: newMessageId(), parts: [{ kind: 'text', text: text.trim() }] };
  if (options.contextId) message.contextId = options.contextId;
  if (options.taskId) message.taskId = options.taskId;
  let body: any;
  try {
    body = await client.apiRequest<any>(`${client.getBaseUrl()}/api/sn_aia/a2a/v2/agent/id/${agentSysId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: message.messageId,
        method: 'message/send',
        params: { message, configuration: { blocking: options.blocking !== false, acceptedOutputModes: outputModes } },
      }),
    });
  } catch (e) {
    a2aError(e);
  }
  if (body?.error) throw new ServiceNowError(`A2A error: ${body.error.message || JSON.stringify(body.error)}`, 'A2A_ERROR');
  const raw = (body?.result ?? body) as A2AV3Message | A2AV3Task;
  const isTask = (raw as A2AV3Task)?.kind === 'task' || !!(raw as A2AV3Task)?.status;
  return {
    reply: a2aReplyText(raw),
    state: isTask ? String((raw as A2AV3Task).status?.state || '') : 'completed',
    taskId: isTask ? (raw as A2AV3Task).id : undefined,
    contextId: (raw as any)?.contextId,
    raw,
  };
}

/** A2A v0.3 `tasks/get` for a task returned by sendAgentMessage. */
export async function getAgentTask(
  client: ServiceNowClient,
  agentSysId: string,
  taskId: string,
  options: { bearerToken: string },
): Promise<A2AV3Task> {
  assertSysId(agentSysId, 'agentSysId');
  const token = requireJwt(options.bearerToken, 'ServiceNow A2A agents');
  const body = await client.apiRequest<any>(`${client.getBaseUrl()}/api/sn_aia/a2a/v2/agent/id/${agentSysId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: newMessageId(), method: 'tasks/get', params: { id: taskId } }),
  }).catch(a2aError);
  if (body?.error) throw new ServiceNowError(`A2A error: ${body.error.message || JSON.stringify(body.error)}`, 'A2A_ERROR');
  return (body?.result ?? body) as A2AV3Task;
}
