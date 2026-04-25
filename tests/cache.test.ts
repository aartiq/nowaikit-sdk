import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaCache } from '../src/cache.js';

function createMockClient(schemaResult: unknown = { table: 'incident', columns: [] }) {
  return {
    getBaseUrl: () => 'https://test.service-now.com',
    getTableSchema: vi.fn().mockResolvedValue(schemaResult),
  } as any;
}

describe('SchemaCache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached value on second call without hitting the API again', async () => {
    const schema = { table: 'incident', columns: [{ element: 'number', value_sample: 'INC0010001' }] };
    const client = createMockClient(schema);
    const cache = new SchemaCache(60_000);

    const first = await cache.getSchema(client, 'incident');
    const second = await cache.getSchema(client, 'incident');

    expect(first).toEqual(schema);
    expect(second).toEqual(schema);
    expect(client.getTableSchema).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expires', async () => {
    const schema = { table: 'problem', columns: [] };
    const client = createMockClient(schema);
    const cache = new SchemaCache(100); // 100ms TTL

    await cache.getSchema(client, 'problem');
    expect(client.getTableSchema).toHaveBeenCalledTimes(1);

    // Advance time past TTL
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.now() + 200) // check: expired
      .mockReturnValueOnce(Date.now() + 200); // set new expiry

    await cache.getSchema(client, 'problem');
    expect(client.getTableSchema).toHaveBeenCalledTimes(2);
  });

  it('invalidate removes a specific table entry', async () => {
    const client = createMockClient({ table: 'change_request', columns: [] });
    const cache = new SchemaCache(60_000);

    await cache.getSchema(client, 'change_request');
    expect(client.getTableSchema).toHaveBeenCalledTimes(1);

    cache.invalidate('change_request');

    await cache.getSchema(client, 'change_request');
    expect(client.getTableSchema).toHaveBeenCalledTimes(2);
  });

  it('clear removes all cached entries', async () => {
    const client = createMockClient();
    const cache = new SchemaCache(60_000);

    await cache.getSchema(client, 'incident');
    await cache.getSchema(client, 'problem');
    expect(client.getTableSchema).toHaveBeenCalledTimes(2);

    cache.clear();

    await cache.getSchema(client, 'incident');
    await cache.getSchema(client, 'problem');
    expect(client.getTableSchema).toHaveBeenCalledTimes(4);
  });

  it('caches different tables independently', async () => {
    const client = createMockClient();
    const cache = new SchemaCache(60_000);

    await cache.getSchema(client, 'incident');
    await cache.getSchema(client, 'problem');
    await cache.getSchema(client, 'incident'); // should be cached

    expect(client.getTableSchema).toHaveBeenCalledTimes(2);
    expect(client.getTableSchema).toHaveBeenCalledWith('incident');
    expect(client.getTableSchema).toHaveBeenCalledWith('problem');
  });
});
