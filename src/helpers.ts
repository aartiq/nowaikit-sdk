import { ServiceNowError } from './errors.js';

/** Validate and sanitize ServiceNow table names (alphanumeric + underscores only) */
export function validateTableName(table: string): string {
  if (!table || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(table)) {
    throw new ServiceNowError(
      `Invalid table name: "${table}". Must contain only letters, numbers, and underscores.`,
      'VALIDATION_ERROR'
    );
  }
  return table;
}

/** Validate ServiceNow sys_id format (32-char hex string) */
export function validateSysId(sysId: string): string {
  if (!sysId || !/^[0-9a-f]{32}$/i.test(sysId)) {
    throw new ServiceNowError(
      `Invalid sys_id: "${sysId}". Must be a 32-character hex string.`,
      'VALIDATION_ERROR'
    );
  }
  return sysId;
}

/** Allowlist of safe GlideSystem functions permitted in javascript: query expressions */
const SAFE_GS_PATTERN = /^javascript:gs\.(getUserID|beginningOfToday|endOfToday|beginningOfYesterday|endOfYesterday|beginningOfLastMonth|endOfLastMonth|beginningOfThisMonth|endOfThisMonth|beginningOfThisQuarter|endOfThisQuarter|beginningOfThisYear|endOfThisYear|beginningOfNextMonth|endOfNextMonth|beginningOfLast7Days|endOfLast7Days|beginningOfLastYear|endOfLastYear|daysAgo|hoursAgo|minutesAgo|monthsAgo|quartersAgo|yearsAgo|now|dateGenerate)\([\d,\s'":-]*\)$/i;

/** Validate and sanitize ServiceNow encoded query strings */
export function validateQuery(query: string): string {
  if (!query) return query;
  const jsMatches = query.match(/javascript:[^@^]*/gi);
  if (jsMatches) {
    for (const match of jsMatches) {
      if (!SAFE_GS_PATTERN.test(match.trim())) {
        throw new ServiceNowError(
          `Query contains unsafe JavaScript expression: "${match.substring(0, 60)}…". Only standard GlideSystem date/user functions are allowed.`,
          'VALIDATION_ERROR'
        );
      }
    }
  }
  if (query.length > 4096) {
    throw new ServiceNowError('Query string exceeds maximum length of 4096 characters.', 'VALIDATION_ERROR');
  }
  return query;
}

/** Sanitize a string for safe inclusion in URLs */
export function sanitizeUrlParam(value: string): string {
  return encodeURIComponent(value);
}
