# nowaikit-sdk

A small TypeScript client for the ServiceNow REST API. No runtime dependencies, native `fetch`, Node 20 or later.

It is the shared core under [NowAIKit](https://nowaikit.com): the same auth, retry and pagination code the NowAIKit MCP server, CLI and desktop app use.

```bash
npm install nowaikit-sdk
```

## Quick start

```ts
import { ServiceNowClient } from 'nowaikit-sdk';

const sn = new ServiceNowClient({
  instanceUrl: 'https://dev12345.service-now.com',
  authMethod: 'basic',
  basic: { username: process.env.SN_USER!, password: process.env.SN_PASS! },
});

const { records } = await sn.queryRecords({ table: 'incident', query: 'active=true', limit: 5, orderBy: '-sys_created_on' });
```

OAuth (password, client credentials, refresh token, JWT bearer), per-user bearer tokens and impersonation are configured on the same constructor. `InstanceManager` reads `~/.config/nowaikit/instances.json`, so a script can reuse instances set up with `nowaikit setup`.

## Modules

| Import | What it gives you |
| --- | --- |
| `nowaikit-sdk` | `ServiceNowClient`, `InstanceManager`, errors, validation helpers, batch helpers, and everything below |
| `nowaikit-sdk/action-fabric` | ServiceNow MCP servers and AI agents over A2A (new in 2.2.0) |
| `nowaikit-sdk/catalog-form` | Catalog item form model and ordering (new in 2.2.0) |
| `nowaikit-sdk/jobs` | Polling for NowAIKit background jobs (new in 2.2.0) |
| `nowaikit-sdk/a2a` | Generic A2A client for agents outside ServiceNow |
| `nowaikit-sdk/now-assist` | Now Assist skills and conversations |
| `nowaikit-sdk/streaming` | Server-sent events reader |
| `nowaikit-sdk/oauth-pkce` | OAuth 2.1 authorization code with PKCE |
| `nowaikit-sdk/cache` | Table schema cache with a TTL |
| `nowaikit-sdk/mcp` | Core SDK operations as plain tool descriptors for any MCP host |
| `nowaikit-sdk/fluent-types` | Types for ServiceNow SDK (Fluent) projects |

## ServiceNow MCP servers and AI agents (Action Fabric)

ServiceNow can publish its own MCP servers (MCP Server Console) and expose AI agents to outside callers over A2A. These helpers talk to both.

The MCP and A2A endpoints only accept a JWT access token from an OAuth authorization code sign-in (the OAuth app must use the JWT token format, and A2A also needs the `a2aauthscope` scope). Reading the registry and fetching agent cards works with whatever auth the client already has.

```ts
import {
  listMcpServers, ServiceNowMcpClient, callServiceNowMcpTool,
  listAiAgents, getAgentCard, sendAgentMessage,
} from 'nowaikit-sdk/action-fabric';

// Registry (sn_mcp_server_registry), with attached tool definitions
const servers = await listMcpServers(sn, { status: 'active' });

// Live MCP over Streamable HTTP: /sncapps/mcp-server/mcp/<name>
const mcp = new ServiceNowMcpClient({ instanceUrl: sn.getBaseUrl(), server: 'sn_mcp_server.default', bearerToken: jwt });
const tools = await mcp.listTools();
const result = await mcp.callTool('look_up_incident_records', { query: 'active=true' });
await mcp.close();

// Or in one call
await callServiceNowMcpTool({ instanceUrl: sn.getBaseUrl(), server: 'sn_mcp_server_default', bearerToken: jwt }, 'incident_summarization', { number: 'INC0010001' });

// AI agents
const agents = await listAiAgents(sn, { exposedOnly: true });
const card = await getAgentCard(sn, agents[0].sys_id);
const reply = await sendAgentMessage(sn, agents[0].sys_id, 'Why is INC0010001 still open?', { bearerToken: jwt });
console.log(reply.state, reply.reply);
// Continue the conversation with { contextId: reply.contextId }, or answer a question with { taskId: reply.taskId }
```

`sendAgentMessage` sends an A2A v0.3 `message/send` to `/api/sn_aia/a2a/v2/agent/id/{id}`. ServiceNow checks `acceptedOutputModes` against the agent card, so the helper reads them from the card unless you pass your own. `getAgentTask` reads a task the agent is still working on.

Errors carry a `code` you can act on: `AUTH_JWT_REQUIRED` and `AUTH_OAUTH_REQUIRED` for the wrong kind of token, `AUTH_SCOPE_REQUIRED` when `a2aauthscope` is missing, `A2A_ASYNC_MODE` when the instance is set to asynchronous external calls, and `NOT_EXPOSED` when the agent is not open to A2A.

## Catalog forms

`getCatalogForm` loads a catalog item through the Service Catalog API and returns a small form model: fields with kinds (`text`, `select`, `reference`, `checkbox`, `container` and so on), choices, reference tables and usable reference qualifiers, defaults, and the item's UI policies with `IO:<sys_id>` references turned into variable names. It is the same model NowAIKit's interactive catalog form uses inside Claude, ChatGPT and other MCP Apps hosts, so you can build your own form on top of it.

```ts
import { getCatalogForm, submitCatalogForm, missingMandatoryFields } from 'nowaikit-sdk/catalog-form';

const form = await getCatalogForm(sn, itemSysId);
for (const f of form.fields) console.log(f.kind, f.name, f.mandatory ? '(required)' : '');

const values = { requested_for: userSysId, justification: 'New starter' };
console.log(missingMandatoryFields(form, values)); // [] when ready

const order = await submitCatalogForm(sn, itemSysId, values, { quantity: 1, form });
console.log(order.requestNumber, order.requestUrl);
```

Variable types the model cannot represent come back as `kind: 'unsupported'` with a `typeLabel`. Client scripts and scripted UI policies only run in ServiceNow; `form.notes` says when an item has them. The normalisers (`normalizeCatalogVariables`, `normalizeCatalogPolicies`, `catalogVariableIdMap`, `flattenFields`) are exported too, if you already have the catalog API response.

## Background jobs

Long-running NowAIKit tools (ATF runs, discovery, transform maps, fluent builds and others) hand back a job when called with `async: true`, or when they run past about 20 seconds. The job is polled with the `get_job` tool. These helpers work with any MCP client: give them a function that calls a NowAIKit tool.

```ts
import { waitForJob, callToolAndWait, isJobHandle, parseToolOutput } from 'nowaikit-sdk/jobs';

const callTool = (name: string, args: Record<string, unknown>) => mcpClient.callTool({ name, arguments: args });

// Start and wait in one step; returns the tool's final result
const result = await callToolAndWait(callTool, 'run_atf_suite', { suite: 'Smoke tests' }, { async: true, timeoutMs: 15 * 60_000 });

// Or follow a job you already have
const first = await callTool('run_discovery_scan', { schedule: 'Nightly' });
if (isJobHandle(first)) {
  const job = await waitForJob(callTool, parseToolOutput(first).job_id, { onProgress: (j) => console.log(j.progress?.message) });
}
```

`waitForJob` asks `get_job` to hold each poll open for up to 20 seconds (`waitSeconds`), so it does not hammer the server. On timeout it throws `JOB_TIMEOUT` and the job keeps running; failed and cancelled jobs come back with `status` set accordingly, and `callToolAndWait` turns them into errors.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
