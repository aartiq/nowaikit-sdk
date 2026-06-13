import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServiceNowClient } from '../src/client.js';

function client() {
  return new ServiceNowClient({
    instanceUrl: 'https://example.service-now.com',
    authMethod: 'basic',
    basic: { username: 'u', password: 'p' },
  });
}

let lastUrl = '';
function mockFetch(body: unknown) {
  return vi.fn().mockImplementation((url: string) => {
    lastUrl = url;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
}

describe('runAggregateQuery', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('uses sysparm_count for COUNT', async () => {
    globalThis.fetch = mockFetch({ result: [] }) as unknown as typeof fetch;
    await client().runAggregateQuery('incident', 'priority', 'COUNT');
    expect(lastUrl).toContain('sysparm_group_by=priority');
    expect(lastUrl).toContain('sysparm_count=true');
  });

  it('maps AVG/SUM to the matching stats fields', async () => {
    globalThis.fetch = mockFetch({ result: [] }) as unknown as typeof fetch;
    await client().runAggregateQuery('incident', 'category', 'AVG:reassignment_count,SUM:reopen_count');
    expect(lastUrl).toContain('sysparm_avg_fields=reassignment_count');
    expect(lastUrl).toContain('sysparm_sum_fields=reopen_count');
    expect(lastUrl).not.toContain('sysparm_count=true');
  });

  it('passes a having clause', async () => {
    globalThis.fetch = mockFetch({ result: [] }) as unknown as typeof fetch;
    await client().runAggregateQuery('incident', 'priority', 'COUNT', 'active=true', { having: 'COUNT>5' });
    expect(lastUrl).toContain('sysparm_having=COUNT%3E5');
    expect(lastUrl).toContain('sysparm_query=active%3Dtrue');
  });
});

describe('getRecordCount', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns the numeric count from stats', async () => {
    globalThis.fetch = mockFetch({ result: { stats: { count: '42' } } }) as unknown as typeof fetch;
    const n = await client().getRecordCount('incident', 'active=true');
    expect(n).toBe(42);
    expect(lastUrl).toContain('sysparm_count=true');
    expect(lastUrl).toContain('sysparm_query=active%3Dtrue');
  });
});
