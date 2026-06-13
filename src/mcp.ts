// @nowaikit/sdk/mcp — Host-agnostic tool adapter.
//
// Exposes the SDK's core operations as plain tool descriptors so any MCP host
// (or the NowAIKit MCP server) can reuse the SDK instead of re-implementing
// REST/auth/retry. Zero MCP-SDK dependency — descriptors are plain JSON Schema.

import type { ServiceNowClient } from './client.js';

export interface SdkToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<unknown>;
}

/**
 * Build the set of core SDK tool descriptors bound to a client instance.
 * Intended to be adapted into MCP tool definitions by the host.
 */
export function createSdkTools(client: ServiceNowClient): SdkToolDescriptor[] {
  const obj = (props: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties: props,
    required,
  });
  const str = (description: string) => ({ type: 'string', description });
  const num = (description: string) => ({ type: 'number', description });

  return [
    {
      name: 'sdk_query_records',
      description: 'Query records from a table with an encoded query, field selection, ordering, and pagination.',
      inputSchema: obj({
        table: str('Table name, e.g. incident'),
        query: str('Encoded query'),
        fields: str('Comma-separated fields'),
        limit: num('Max records (default 10)'),
        offset: num('Offset for pagination'),
        orderBy: str('Field to sort by; prefix - for descending'),
      }, ['table']),
      handler: (a) => client.queryRecords({ table: a.table, query: a.query, fields: a.fields, limit: a.limit, offset: a.offset, orderBy: a.orderBy }),
    },
    {
      name: 'sdk_get_all_records',
      description: 'Fetch ALL records matching a query, transparently following pagination past the 1000-row cap.',
      inputSchema: obj({ table: str('Table name'), query: str('Encoded query'), fields: str('Comma-separated fields') }, ['table']),
      handler: (a) => client.getAllRecords({ table: a.table, query: a.query, fields: a.fields }),
    },
    {
      name: 'sdk_get_record',
      description: 'Get a single record by sys_id.',
      inputSchema: obj({ table: str('Table name'), sys_id: str('Record sys_id'), fields: str('Comma-separated fields') }, ['table', 'sys_id']),
      handler: (a) => client.getRecord(a.table, a.sys_id, a.fields),
    },
    {
      name: 'sdk_get_record_count',
      description: 'Count records matching an optional encoded query (single lightweight stats call).',
      inputSchema: obj({ table: str('Table name'), query: str('Encoded query') }, ['table']),
      handler: (a) => client.getRecordCount(a.table, a.query),
    },
    {
      name: 'sdk_get_dictionary',
      description: 'Return the real column dictionary (type, label, mandatory, reference, max length) for a table.',
      inputSchema: obj({ table: str('Table name') }, ['table']),
      handler: (a) => client.getDictionary(a.table),
    },
    {
      name: 'sdk_run_aggregate',
      description: 'Run a stats aggregate (COUNT, AVG:field, SUM:field, MIN:field, MAX:field) with optional group-by and having.',
      inputSchema: obj({
        table: str('Table name'),
        groupBy: str('Group-by field(s), comma-separated'),
        aggregate: str('COUNT or AVG:field / SUM:field / MIN:field / MAX:field'),
        query: str('Encoded query'),
        having: str('Having clause, e.g. COUNT>5'),
      }, ['table']),
      handler: (a) => client.runAggregateQuery(a.table, a.groupBy || '', a.aggregate || 'COUNT', a.query, a.having ? { having: a.having } : undefined),
    },
    {
      name: 'sdk_list_attachments',
      description: 'List attachment metadata for a record.',
      inputSchema: obj({ table: str('Table name'), sys_id: str('Record sys_id') }, ['table', 'sys_id']),
      handler: (a) => client.listAttachments(a.table, a.sys_id),
    },
    {
      name: 'sdk_get_instance_stats',
      description: 'Return instance version/build metadata.',
      inputSchema: obj({}),
      handler: () => client.getInstanceStats(),
    },
  ];
}
