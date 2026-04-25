// Table schema caching with configurable TTL
// Reduces redundant API calls for schema introspection
/**
 * Caches table schema responses to avoid repeated API calls.
 * Entries expire after a configurable TTL (default: 5 minutes).
 */
export class SchemaCache {
    cache = new Map();
    ttlMs;
    constructor(ttlMs = 300_000) {
        this.ttlMs = ttlMs;
    }
    /**
     * Get the schema for a table, returning a cached value if available and fresh.
     * On cache miss, calls client.getTableSchema() and stores the result.
     */
    async getSchema(client, table) {
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
    invalidate(table) {
        this.cache.delete(table);
    }
    /** Remove all cached schemas. */
    clear() {
        this.cache.clear();
    }
}
//# sourceMappingURL=cache.js.map