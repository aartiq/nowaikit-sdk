import { describe, it, expect } from 'vitest';
import { validateTableName, validateSysId, validateQuery, sanitizeUrlParam } from '../src/helpers.js';

describe('validateTableName', () => {
  it('accepts valid table names', () => {
    expect(validateTableName('incident')).toBe('incident');
    expect(validateTableName('cmdb_ci_server')).toBe('cmdb_ci_server');
    expect(validateTableName('x_aartiq_myapp_table')).toBe('x_aartiq_myapp_table');
  });

  it('rejects empty string', () => {
    expect(() => validateTableName('')).toThrow('Invalid table name');
  });

  it('rejects names starting with numbers', () => {
    expect(() => validateTableName('123table')).toThrow('Invalid table name');
  });

  it('rejects names with special characters', () => {
    expect(() => validateTableName('incident; DROP TABLE')).toThrow('Invalid table name');
  });

  it('rejects names with dots', () => {
    expect(() => validateTableName('sys.user')).toThrow('Invalid table name');
  });
});

describe('validateSysId', () => {
  it('accepts valid 32-char hex sys_id', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    expect(validateSysId(id)).toBe(id);
  });

  it('accepts uppercase hex', () => {
    const id = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';
    expect(validateSysId(id)).toBe(id);
  });

  it('rejects empty string', () => {
    expect(() => validateSysId('')).toThrow('Invalid sys_id');
  });

  it('rejects short strings', () => {
    expect(() => validateSysId('abc123')).toThrow('Invalid sys_id');
  });

  it('rejects non-hex characters', () => {
    expect(() => validateSysId('g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toThrow('Invalid sys_id');
  });
});

describe('validateQuery', () => {
  it('passes through valid encoded queries', () => {
    expect(validateQuery('active=true^priority=1')).toBe('active=true^priority=1');
  });

  it('allows safe GlideSystem functions', () => {
    const query = 'opened_at>javascript:gs.beginningOfToday()';
    expect(validateQuery(query)).toBe(query);
  });

  it('returns empty/falsy queries as-is', () => {
    expect(validateQuery('')).toBe('');
  });

  it('rejects unsafe JavaScript expressions', () => {
    expect(() => validateQuery('active=javascript:eval("malicious")')).toThrow('unsafe JavaScript');
  });

  it('rejects queries exceeding 4096 characters', () => {
    const longQuery = 'a'.repeat(4097);
    expect(() => validateQuery(longQuery)).toThrow('exceeds maximum length');
  });
});

describe('sanitizeUrlParam', () => {
  it('encodes special characters', () => {
    expect(sanitizeUrlParam('hello world')).toBe('hello%20world');
  });

  it('encodes slashes', () => {
    expect(sanitizeUrlParam('path/to/resource')).toBe('path%2Fto%2Fresource');
  });

  it('passes through safe characters', () => {
    expect(sanitizeUrlParam('simple')).toBe('simple');
  });

  it('encodes ampersands and equals signs', () => {
    expect(sanitizeUrlParam('key=value&other=val')).toBe('key%3Dvalue%26other%3Dval');
  });
});
