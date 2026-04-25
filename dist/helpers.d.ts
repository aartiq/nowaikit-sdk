/** Validate and sanitize ServiceNow table names (alphanumeric + underscores only) */
export declare function validateTableName(table: string): string;
/** Validate ServiceNow sys_id format (32-char hex string) */
export declare function validateSysId(sysId: string): string;
/** Validate and sanitize ServiceNow encoded query strings */
export declare function validateQuery(query: string): string;
/** Sanitize a string for safe inclusion in URLs */
export declare function sanitizeUrlParam(value: string): string;
//# sourceMappingURL=helpers.d.ts.map