// Table schema caching with configurable TTL
// Reduces redundant API calls for schema introspection

import type { ServiceNowClient } from './client.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Caches table schema responses to avoid repeated API calls.
 * Entries expire after a configurable TTL (default: 5 minutes).
 */
export class SchemaCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private ttlMs: number;

  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get the schema for a table, returning a cached value if available and fresh.
   * On cache miss, calls client.getTableSchema() and stores the result.
   */
  async getSchema(client: ServiceNowClient, table: string): Promise<any> {
    const existing = this.cache.get(table);
    if (existing && Date.now() < existing.expiresAt) {
      return existing.data;
    }

    const schema = await client.getTableSchema(table);
    this.cache.set(table, {
      data: schema,
      expiresAt: Date.now() + this.ttlMs,
    });

    return schema;
  }

  /** Remove a specific table's cached schema. */
  invalidate(table: string): void {
    this.cache.delete(table);
  }

  /** Remove all cached schemas. */
  clear(): void {
    this.cache.clear();
  }
}
