# Changelog

## [2.2.0] - 2026-11-19

Helpers for the NowAIKit 5.0 surfaces.

### Added
- `nowaikit-sdk/action-fabric`: list ServiceNow MCP servers from the MCP Server Console registry, a zero-dependency MCP client for `/sncapps/mcp-server/mcp/<name>` over Streamable HTTP (`ServiceNowMcpClient`, `listServiceNowMcpTools`, `callServiceNowMcpTool`), and ServiceNow AI agents over A2A v0.3 (`listAiAgents`, `getAgentCard`, `sendAgentMessage`, `getAgentTask`). Output modes for `message/send` come from the agent card.
- `nowaikit-sdk/catalog-form`: `getCatalogForm` returns the normalised form model NowAIKit's interactive catalog form uses (fields, choices, references, defaults, UI policies), `missingMandatoryFields` checks values, and `submitCatalogForm` orders the item.
- `nowaikit-sdk/jobs`: `waitForJob` and `callToolAndWait` follow NowAIKit background jobs through the `get_job` tool. They accept parsed output or raw MCP `CallToolResult` values.
- README for the package.

## [2.0.0] — 2026-04-25

### Added
- A2A (Agent-to-Agent) protocol client
- SSE streaming support for long-running operations
- OAuth 2.1 + PKCE authentication flow
- Table schema caching with configurable TTL
- Now Assist API client (skill execution, conversations)
- Fluent/now-sdk TypeScript type definitions
- Comprehensive test suite with vitest

### Changed
- Bumped to v2.0.0 (new exports, new auth method)
