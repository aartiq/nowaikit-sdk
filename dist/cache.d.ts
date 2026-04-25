import type { ServiceNowClient } from './client.js';
/**
 * Caches table schema responses to avoid repeated API calls.
 * Entries expire after a configurable TTL (default: 5 minutes).
 */
export declare class SchemaCache {
    private cache;
    private ttlMs;
    constructor(ttlMs?: number);
    /**
     * Get the schema for a table, returning a cached value if available and fresh.
     * On cache miss, calls client.getTableSchema() and stores the result.
     */
    getSchema(client: ServiceNowClient, table: string): Promise<any>;
    /** Remove a specific table's cached schema. */
    invalidate(table: string): void;
    /** Remove all cached schemas. */
    clear(): void;
}
//# sourceMappingURL=cache.d.ts.map