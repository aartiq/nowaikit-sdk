import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServiceNowClient } from '../src/client.js';
import { createSdkTools } from '../src/mcp.js';

function client(extra: Record<string, unknown> = {}) {
  return new ServiceNowClient({
    instanceUrl: 'https://example.service-now.com',
    authMethod: 'basic',
    basic: { username: 'u', password: 'p' },
    maxRetries: 0,
    ...extra,
  });
}

function ok(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('iterateRecords / getAllRecords', () => {
  it('follows pagination until a short page', async () => {
    // 2 full pages of 1000 then a short page of 3 -> 2003 total
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const offset = Number(new URL(url).searchParams.get('sysparm_offset') || '0');
      let n: number;
      if (offset === 0) n = 1000;
      else if (offset === 1000) n = 1000;
      else n = 3;
      const records = Array.from({ length: n }, (_, i) => ({ sys_id: String(offset + i) }));
      return Promise.resolve(ok({ result: records }));
    }) as unknown as typeof fetch;

    const all = await client().getAllRecords({ table: 'incident' });
    expect(all.length).toBe(2003);
  });

  it('respects a hard limit', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(ok({ result: Array.from({ length: 1000 }, (_, i) => ({ sys_id: String(i) })) }))
    ) as unknown as typeof fetch;
    const all = await client().getAllRecords({ table: 'incident', limit: 1500 });
    expect(all.length).toBe(1500);
  });
});

describe('getDictionary', () => {
  it('parses sys_dictionary rows into typed columns', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({
      result: [
        {
          element: { value: 'short_description', display_value: 'short_description' },
          column_label: { value: 'Short description', display_value: 'Short description' },
          internal_type: { value: 'string', display_value: 'String' },
          max_length: { value: '160', display_value: '160' },
          mandatory: { value: 'true', display_value: 'true' },
          read_only: { value: 'false', display_value: 'false' },
          reference: { value: '', display_value: '' },
          default_value: { value: '', display_value: '' },
        },
        {
          element: { value: 'caller_id', display_value: 'caller_id' },
          column_label: { value: 'Caller', display_value: 'Caller' },
          internal_type: { value: 'reference', display_value: 'Reference' },
          max_length: { value: '32', display_value: '32' },
          mandatory: { value: 'false', display_value: 'false' },
          read_only: { value: 'false', display_value: 'false' },
          reference: { value: 'sys_user', display_value: 'User' },
          default_value: { value: '', display_value: '' },
        },
      ],
    })) as unknown as typeof fetch;

    const dict = await client().getDictionary('incident');
    expect(dict.columns).toHaveLength(2);
    const sd = dict.columns.find((c) => c.element === 'short_description')!;
    expect(sd.mandatory).toBe(true);
    expect(sd.internal_type).toBe('String');
    expect(sd.max_length).toBe(160);
    const caller = dict.columns.find((c) => c.element === 'caller_id')!;
    expect(caller.reference).toBe('User');
  });
});

describe('getInstanceStats', () => {
  it('maps sys_properties rows to fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({
      result: [
        { name: 'glide.war', value: 'glide-zurich-12-18-2025' },
        { name: 'glide.buildname', value: 'zurich' },
      ],
    })) as unknown as typeof fetch;
    const stats = await client().getInstanceStats();
    expect(stats.version).toContain('zurich');
    expect(stats.buildName).toBe('zurich');
    expect(stats.instanceUrl).toBe('https://example.service-now.com');
  });
});

describe('429 handling', () => {
  it('retries on 429 honoring Retry-After then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '0' : null) },
          text: () => Promise.resolve('{}'), json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve(ok({ result: [{ sys_id: '1' }] }));
    }) as unknown as typeof fetch;

    const res = await client({ maxRetries: 2 }).queryRecords({ table: 'incident' });
    expect(res.count).toBe(1);
    expect(calls).toBe(2);
  });
});

describe('createSdkTools', () => {
  it('exposes named tool descriptors with handlers', () => {
    const tools = createSdkTools(client());
    const names = tools.map((t) => t.name);
    expect(names).toContain('sdk_query_records');
    expect(names).toContain('sdk_get_dictionary');
    expect(names).toContain('sdk_get_record_count');
    for (const t of tools) {
      expect(typeof t.handler).toBe('function');
      expect(t.inputSchema).toBeTypeOf('object');
    }
  });
});
