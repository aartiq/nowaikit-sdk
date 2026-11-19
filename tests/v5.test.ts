import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServiceNowClient } from '../src/client.js';
import {
  listMcpServers, mcpEndpointName, mcpServerUrl, isJwt, ServiceNowMcpClient, callServiceNowMcpTool,
  getAgentCard, sendAgentMessage, listAiAgents, a2aReplyText,
} from '../src/action-fabric.js';
import {
  normalizeCatalogVariables, normalizeCatalogPolicies, catalogVariableIdMap, getCatalogForm, submitCatalogForm,
  missingMandatoryFields,
} from '../src/catalog-form.js';
import { waitForJob, callToolAndWait, isJobHandle, parseToolOutput } from '../src/jobs.js';

const BASE = 'https://example.service-now.com';
const JWT = 'aaa.bbb.ccc';
const AGENT = 'a'.repeat(32);
const ITEM = 'b'.repeat(32);

function client() {
  return new ServiceNowClient({ instanceUrl: BASE, authMethod: 'basic', basic: { username: 'u', password: 'p' }, maxRetries: 1, retryDelayMs: 1 });
}

function res(body: unknown, opts: { status?: number; headers?: Record<string, string>; raw?: string } = {}) {
  const status = opts.status ?? 200;
  const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = opts.raw ?? (body === undefined ? '' : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'X',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('action fabric helpers', () => {
  it('builds endpoint names and URLs', () => {
    expect(mcpEndpointName('sn_mcp_server.default')).toBe('sn_mcp_server_default');
    expect(mcpServerUrl(`${BASE}/`, 'sn_mcp_server.default')).toBe(`${BASE}/sncapps/mcp-server/mcp/sn_mcp_server_default`);
    expect(() => mcpServerUrl(BASE, 'bad name/../x')).toThrow(/server must be/);
    expect(isJwt(JWT)).toBe(true);
    expect(isJwt('opaque-token')).toBe(false);
  });

  it('lists MCP servers with their tools resolved', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ result: [{ sys_id: '1', name: 'sn_mcp_server.default', label: 'Default', status: 'active', tools: 't1,t2', description: 'd' }] }))
      .mockResolvedValueOnce(res({ result: [{ sys_id: 't1', name: 'incident_summary', sys_class_name: 'sn_mcp_skill_tool_definition' }] }));
    globalThis.fetch = fetchMock as any;
    const servers = await listMcpServers(client(), { status: 'active' });
    expect(fetchMock.mock.calls[0][0]).toContain('sn_mcp_server_registry');
    expect(decodeURIComponent(fetchMock.mock.calls[0][0])).toContain('status=active');
    expect(servers[0].endpoint).toBe(`${BASE}/sncapps/mcp-server/mcp/sn_mcp_server_default`);
    expect(servers[0].tools).toEqual([{ sys_id: 't1', name: 'incident_summary', type: 'skill' }, { sys_id: 't2' }]);
  });

  it('refuses a non-JWT token for MCP', () => {
    expect(() => new ServiceNowMcpClient({ instanceUrl: BASE, server: 's', bearerToken: 'opaque' })).toThrow(/JWT/);
  });

  it('runs the MCP handshake and tool call over Streamable HTTP (JSON and SSE replies)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sn' } } }, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } }))
      .mockResolvedValueOnce(res(undefined, { status: 202 }))
      .mockResolvedValueOnce(res(undefined, {
        headers: { 'content-type': 'text/event-stream' },
        raw: 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"done"}]}}\n\n',
      }))
      .mockResolvedValueOnce(res(undefined, { status: 200 }));
    globalThis.fetch = fetchMock as any;
    const out = await callServiceNowMcpTool({ instanceUrl: BASE, server: 'sn_mcp_server_default', bearerToken: `Bearer ${JWT}` }, 'summarize', { number: 'INC1' });
    expect(out.content?.[0].text).toBe('done');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/sncapps/mcp-server/mcp/sn_mcp_server_default`);
    expect(init.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(JSON.parse(init.body).method).toBe('initialize');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).method).toBe('notifications/initialized');
    const call = fetchMock.mock.calls[2][1];
    expect(call.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(JSON.parse(call.body)).toMatchObject({ method: 'tools/call', params: { name: 'summarize', arguments: { number: 'INC1' } } });
    expect(fetchMock.mock.calls[3][1].method).toBe('DELETE');
  });

  it('maps a 401 from the MCP endpoint to an auth error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res({ error: 'x' }, { status: 401 })) as any;
    const mcp = new ServiceNowMcpClient({ instanceUrl: BASE, server: 'x', bearerToken: JWT });
    await expect(mcp.listTools()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('fetches an agent card', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res({ result: { name: 'Helper', defaultOutputModes: ['application/json'] } }));
    globalThis.fetch = fetchMock as any;
    const card = await getAgentCard(client(), AGENT);
    expect(card.name).toBe('Helper');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sn_aia/a2a/v2/agent_card/id/${AGENT}`);
    await expect(getAgentCard(client(), 'nope')).rejects.toThrow(/sys_id/);
  });

  it('sends message/send with output modes from the card and a JWT bearer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ result: { name: 'Helper', defaultOutputModes: ['text/plain', 'application/json'] } }))
      .mockResolvedValueOnce(res({ jsonrpc: '2.0', result: { kind: 'task', id: 'task-1', contextId: 'ctx-1', status: { state: 'completed', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'All set' }] } } } }));
    globalThis.fetch = fetchMock as any;
    const out = await sendAgentMessage(client(), AGENT, 'Hello', { bearerToken: JWT, contextId: 'ctx-0' });
    expect(out).toMatchObject({ reply: 'All set', state: 'completed', taskId: 'task-1', contextId: 'ctx-1' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/sn_aia/a2a/v2/agent/id/${AGENT}`);
    expect(init.headers.Authorization).toBe(`Bearer ${JWT}`);
    const body = JSON.parse(init.body);
    expect(body.method).toBe('message/send');
    expect(body.params.configuration).toEqual({ blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] });
    expect(body.params.message).toMatchObject({ kind: 'message', role: 'user', contextId: 'ctx-0', parts: [{ kind: 'text', text: 'Hello' }] });
  });

  it('explains a missing a2aauthscope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(res({ error: { message: 'Missing scope: a2aauthscope' } }, { status: 403 })) as any;
    await expect(sendAgentMessage(client(), AGENT, 'Hi', { bearerToken: JWT, acceptedOutputModes: ['text/plain'] })).rejects.toMatchObject({ code: 'AUTH_SCOPE_REQUIRED' });
  });

  it('lists agents with A2A exposure', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(res({ result: [{ sys_id: 'x1', name: 'A' }, { sys_id: 'x2', name: 'B' }, { sys_id: 'x3', name: 'C' }] }))
      .mockResolvedValueOnce(res({ result: [{ agent: 'x1', public: 'true', active: 'true' }, { agent: 'x3', public: 'false', active: 'false' }] })) as any;
    const agents = await listAiAgents(client());
    expect(agents.map((a) => [a.name, a.a2a_exposed])).toEqual([['A', true], ['B', false]]);
  });

  it('reads reply text from messages and tasks', () => {
    expect(a2aReplyText({ kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'hi' }, { kind: 'data', data: { a: 1 } }] })).toBe('hi\n{"a":1}');
    expect(a2aReplyText({ kind: 'task', id: 't', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'art' }] }] })).toBe('art');
  });
});

const VARS = [
  { id: 'v1', name: 'requested_for', label: 'Requested for', friendly_type: 'requested_for', active: true, mandatory: true, value: 'javascript:gs.getUserID()' },
  { id: 'v2', name: 'size', label: 'Size', type: 5, active: true, choices: [{ value: '', label: '-- None --' }, { value: 's', label: 'Small' }] },
  { id: 'v3', name: 'brk', friendly_type: 'break' },
  {
    id: 'c1', name: 'opts', label: 'Options', friendly_type: 'container_start', containerType: 'checkbox_container', active: false,
    children: [{ id: 'v4', name: 'gift', label: 'Gift wrap', friendly_type: 'check_box', active: true }],
  },
  { id: 'v5', name: 'why', label: 'Why', friendly_type: 'multi_line_text', active: true, mandatory: true },
  { id: 'v6', name: 'old', label: 'Old', friendly_type: 'single_line_text', active: false },
  { id: 'v7', name: 'macro', label: 'Macro', friendly_type: 'macro', active: true },
];

describe('catalog form model', () => {
  it('normalises variables like the NowAIKit view', () => {
    const fields = normalizeCatalogVariables(VARS, { currentUserSysId: 'u1', currentUserName: 'Abel' });
    expect(fields.map((f) => f.name)).toEqual(['requested_for', 'size', 'opts', 'why', 'macro']);
    expect(fields[0]).toMatchObject({ kind: 'reference', reference: 'sys_user', value: 'u1', displayValue: 'Abel', mandatory: true });
    expect(fields[1].choices).toEqual([{ value: '', label: '-- None --' }, { value: 's', label: 'Small' }]);
    expect(fields[2]).toMatchObject({ kind: 'container', label: '', children: [{ name: 'gift', kind: 'checkbox' }] });
    expect(fields[4]).toMatchObject({ kind: 'unsupported', typeLabel: 'macro' });
  });

  it('translates UI policies to variable names', () => {
    const policies = normalizeCatalogPolicies([
      { short_description: 'p', onload: true, reverse: true, conditions: [{ field: 'IO:v2', oper: '=', value: 's' }], actions: [{ name: 'IO:v5', visible: 'false', mandatory: 'ignore' }] },
      { short_description: 'empty', conditions: [], actions: [{ name: 'IO:v5', visible: 'ignore' }] },
    ], catalogVariableIdMap(VARS));
    expect(policies).toEqual([{ description: 'p', onLoad: true, reverse: true, conditions: [{ field: 'size', oper: '=', value: 's' }], actions: [{ field: 'why', visible: false }] }]);
  });

  it('getCatalogForm builds the model from the Service Catalog API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ result: { sys_id: ITEM, name: 'Laptop', variables: VARS, ui_policy: [], client_script: { onLoad: [{}] }, category: { title: 'Hardware' } } }))
      .mockResolvedValueOnce(res({ result: { user_sys_id: 'u1', user_display_name: 'Abel' } }));
    globalThis.fetch = fetchMock as any;
    const form = await getCatalogForm(client(), ITEM);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sn_sc/servicecatalog/items/${ITEM}`);
    expect(form.item).toMatchObject({ name: 'Laptop', category: 'Hardware' });
    expect(form.mandatoryVariables).toEqual(['requested_for', 'why']);
    expect(form.notes[0]).toMatch(/client script/);
    expect(form.itemUrl).toBe(`${BASE}/sp?id=sc_cat_item&sys_id=${ITEM}`);
  });

  it('checks mandatory fields and orders the item', async () => {
    const form = { fields: normalizeCatalogVariables(VARS), policies: [] };
    expect(missingMandatoryFields(form, {})).toEqual(['Requested for', 'Why']);
    await expect(submitCatalogForm(client(), ITEM, { requested_for: 'u1' }, { form })).rejects.toThrow(/Why/);
    const fetchMock = vi.fn().mockResolvedValue(res({ result: { request_number: 'REQ0010001', request_id: 'r'.repeat(32), table: 'sc_request' } }));
    globalThis.fetch = fetchMock as any;
    const out = await submitCatalogForm(client(), ITEM, { requested_for: 'u1', why: 'new hire', bad$key: 'x', gift: true }, { quantity: 2, form });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sn_sc/servicecatalog/items/${ITEM}/order_now`);
    expect(JSON.parse(init.body)).toEqual({ sysparm_quantity: 2, variables: { requested_for: 'u1', why: 'new hire', gift: 'true' } });
    expect(out.requestNumber).toBe('REQ0010001');
    expect(out.requestUrl).toContain('sc_request.do');
  });
});

describe('job polling', () => {
  const text = (o: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });

  it('parses tool output in both shapes', () => {
    expect(parseToolOutput(text({ a: 1 }))).toEqual({ a: 1 });
    expect(parseToolOutput({ structuredContent: { b: 2 }, content: [] })).toEqual({ b: 2 });
    expect(() => parseToolOutput({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow('boom');
    expect(isJobHandle(text({ job_id: 'j1', status: 'running' }))).toBe(true);
    expect(isJobHandle({ rows: [] })).toBe(false);
  });

  it('waitForJob polls get_job until a terminal state', async () => {
    const calls: unknown[] = [];
    const caller = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return calls.length < 3 ? text({ job_id: 'j1', status: 'running', progress: { percent: calls.length * 30 } }) : { job_id: 'j1', status: 'completed', result: { ok: true } };
    });
    const seen: number[] = [];
    const job = await waitForJob(caller, 'j1', { intervalMs: 1, waitSeconds: 5, onProgress: (j) => seen.push(j.progress?.percent ?? 100) });
    expect(job.status).toBe('completed');
    expect(job.result).toEqual({ ok: true });
    expect(calls[0]).toEqual(['get_job', { job_id: 'j1', wait_seconds: 5 }]);
    expect(seen).toEqual([30, 60, 100]);
  });

  it('times out while the job is still running', async () => {
    const caller = vi.fn(async () => ({ job_id: 'j1', status: 'running' }));
    await expect(waitForJob(caller, 'j1', { intervalMs: 1, timeoutMs: 20, waitSeconds: 0 })).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
  });

  it('callToolAndWait returns the direct result or the finished job result', async () => {
    const direct = vi.fn(async () => text({ value: 1 }));
    expect(await callToolAndWait(direct, 'list_x')).toEqual({ value: 1 });

    const viaJob = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'run_atf_suite') { expect(args.async).toBe(true); return text({ job_id: 'j9', status: 'running' }); }
      return text({ job_id: 'j9', status: 'completed', result: { passed: 3 } });
    });
    expect(await callToolAndWait(viaJob, 'run_atf_suite', { suite: 's' }, { async: true, intervalMs: 1 })).toEqual({ passed: 3 });

    const failing = vi.fn(async (name: string) => name === 'get_job'
      ? { job_id: 'j2', status: 'failed', error: { message: 'suite crashed', code: 'API_ERROR' } }
      : { job_id: 'j2', status: 'running' });
    await expect(callToolAndWait(failing, 'run_atf_suite', {}, { intervalMs: 1 })).rejects.toThrow('suite crashed');
  });
});
