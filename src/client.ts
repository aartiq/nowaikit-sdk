import type {
  AuthMode,
  ServiceNowConfig,
  QueryRecordsParams,
  QueryRecordsResponse,
  OAuthTokenResponse,
  ServiceNowApiResponse,
  ServiceNowRecord,
  BatchRequestItem,
  BatchResponseItem,
  RequestHooks,
  OAuthGrantType,
  DictionaryColumn,
  TableDictionary,
  AttachmentMeta,
  ImportSetResult,
  InstanceStats,
} from './types.js';
import { ServiceNowError } from './errors.js';
import { validateTableName, validateSysId, validateQuery } from './helpers.js';
import { buildBatchPayload, parseBatchResponse } from './batch.js';

/** Browser- and Node-safe base64 encode of a UTF-8 string. */
function base64Encode(input: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(input, 'utf8').toString('base64');
  // Browser fallback
  // eslint-disable-next-line no-undef
  return btoa(unescape(encodeURIComponent(input)));
}

/** Browser- and Node-safe base64 encode of binary bytes. */
function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/** Browser- and Node-safe base64 decode to bytes. */
function bytesFromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  // eslint-disable-next-line no-undef
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Simple logger that writes to stderr (non-intrusive for MCP/CLI). */
const logger = {
  debug(message: string, _data?: unknown): void {
    if (process.env.NOWAIKIT_DEBUG === 'true') console.error(`[DEBUG] ${message}`);
  },
  info(message: string, _data?: unknown): void {
    console.error(`[INFO] ${message}`);
  },
  warn(message: string, _data?: unknown): void {
    console.error(`[WARN] ${message}`);
  },
};

export class ServiceNowClient {
  private baseUrl: string;
  private authMethod: 'oauth' | 'basic';
  private authMode: AuthMode;
  private oauthConfig?: ServiceNowConfig['oauth'];
  private basicConfig?: ServiceNowConfig['basic'];
  private maxRetries: number;
  private retryDelayMs: number;
  private requestTimeoutMs: number;
  private impersonateUserSysId?: string;
  private perUserBearerToken?: string;
  private accessToken?: string;
  private tokenExpiry?: number;
  private refreshToken?: string;
  private hooks?: RequestHooks;
  private onTokenRefresh?: ServiceNowConfig['onTokenRefresh'];

  constructor(config: ServiceNowConfig) {
    this.baseUrl = config.instanceUrl.replace(/\/$/, '');
    this.authMethod = config.authMethod;
    this.authMode = config.authMode || 'service-account';
    this.oauthConfig = config.oauth;
    this.basicConfig = config.basic;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.requestTimeoutMs = config.requestTimeoutMs || 30000;
    this.impersonateUserSysId = config.impersonateUserSysId;
    this.perUserBearerToken = config.perUserBearerToken;
    this.refreshToken = config.oauth?.refreshToken;
    this.hooks = config.hooks;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  /** Return the base instance URL. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Low-level authenticated request helper for trusted SDK submodules
   * (e.g. NowAssistClient). Prefer the typed domain methods where they exist.
   * @internal
   */
  async apiRequest<T = any>(url: string, options: RequestInit = {}): Promise<T> {
    await this.authenticate();
    return this.request<T>(url, options);
  }

  /** Return a copy configured for a specific user context. */
  withUser(options: { sysId?: string; bearerToken?: string }): ServiceNowClient {
    const copy = Object.create(Object.getPrototypeOf(this)) as ServiceNowClient;
    Object.assign(copy, this);
    if (options.sysId) {
      copy.authMode = 'impersonation';
      copy.impersonateUserSysId = options.sysId;
    }
    if (options.bearerToken) {
      copy.authMode = 'per-user';
      copy.perUserBearerToken = options.bearerToken;
    }
    return copy;
  }

  // ─── Authentication ────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (this.authMethod === 'basic') return;
    if (this.authMode === 'per-user' && this.perUserBearerToken) return;

    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) return;

    if (!this.oauthConfig?.clientId || !this.oauthConfig?.clientSecret) {
      throw new ServiceNowError('OAuth client ID and secret are required', 'AUTHENTICATION_FAILED');
    }

    // If a token has expired but we hold a refresh token, prefer refreshing.
    const grant: OAuthGrantType =
      this.refreshToken && this.oauthConfig.grantType !== 'client_credentials'
        ? 'refresh_token'
        : (this.oauthConfig.grantType || 'password');

    const body = new URLSearchParams({
      client_id: this.oauthConfig.clientId,
      client_secret: this.oauthConfig.clientSecret,
    });

    switch (grant) {
      case 'refresh_token':
        if (!this.refreshToken) throw new ServiceNowError('No refresh token available', 'AUTHENTICATION_FAILED');
        body.set('grant_type', 'refresh_token');
        body.set('refresh_token', this.refreshToken);
        break;
      case 'client_credentials':
        body.set('grant_type', 'client_credentials');
        break;
      case 'jwt':
        if (!this.oauthConfig.jwtAssertion) throw new ServiceNowError('JWT assertion required for jwt grant', 'AUTHENTICATION_FAILED');
        body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        body.set('assertion', this.oauthConfig.jwtAssertion);
        break;
      case 'password':
      default:
        if (!this.oauthConfig.username || !this.oauthConfig.password) {
          throw new ServiceNowError('Username and password are required for OAuth password grant', 'AUTHENTICATION_FAILED');
        }
        body.set('grant_type', 'password');
        body.set('username', this.oauthConfig.username);
        body.set('password', this.oauthConfig.password);
        break;
    }

    const tokenUrl = `${this.baseUrl}/oauth_token.do`;
    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        // A failed refresh falls back to the configured primary grant once.
        if (grant === 'refresh_token') {
          this.refreshToken = undefined;
          return this.authenticate();
        }
        throw new ServiceNowError(
          `OAuth authentication failed: ${response.status} ${response.statusText}`,
          'AUTHENTICATION_FAILED'
        );
      }

      const tokenData = await response.json() as OAuthTokenResponse;
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = Date.now() + (tokenData.expires_in * 1000 * 0.9);
      if (tokenData.refresh_token) this.refreshToken = tokenData.refresh_token;
      this.onTokenRefresh?.({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.tokenExpiry });
      logger.debug(`OAuth token acquired (${grant})`);
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(
        `OAuth authentication error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'AUTHENTICATION_FAILED'
      );
    }
  }

  private getAuthHeader(): string {
    if (this.authMode === 'per-user' && this.perUserBearerToken) {
      return `Bearer ${this.perUserBearerToken}`;
    }
    if (this.authMethod === 'basic') {
      if (!this.basicConfig?.username || !this.basicConfig?.password) {
        throw new ServiceNowError('Username and password are required for Basic auth', 'AUTHENTICATION_FAILED');
      }
      return `Basic ${base64Encode(`${this.basicConfig.username}:${this.basicConfig.password}`)}`;
    }
    if (!this.accessToken) {
      throw new ServiceNowError('OAuth token not available. Call authenticate() first.', 'AUTHENTICATION_FAILED');
    }
    return `Bearer ${this.accessToken}`;
  }

  private getImpersonateHeader(): string | undefined {
    if (this.authMode === 'impersonation' && this.impersonateUserSysId) {
      return this.impersonateUserSysId;
    }
    return undefined;
  }

  // ─── HTTP Request Layer ────────────────────────────────────────────────────

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        const extraHeaders: Record<string, string> = {};
        const impersonateHeader = this.getImpersonateHeader();
        if (impersonateHeader) extraHeaders['X-Sn-Impersonate'] = impersonateHeader;

        let fetchOptions: RequestInit = {
          ...options,
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': this.getAuthHeader(),
            ...extraHeaders,
            ...options.headers,
          },
        };

        // onRequest hook may override the request init.
        if (this.hooks?.onRequest) {
          const override = await this.hooks.onRequest({ url, options: fetchOptions });
          if (override) fetchOptions = { ...fetchOptions, ...override };
        }

        const startedAt = Date.now();
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        if (!response.ok) {
          // Respect rate limiting before treating as a hard error.
          if (response.status === 429 && attempt < this.maxRetries) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : this.retryDelayMs * Math.pow(2, attempt);
            this.hooks?.onRetry?.({ url, attempt: attempt + 1, delayMs: delay, error: 'HTTP 429' });
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          const errorText = await response.text();
          let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error?.message) errorMessage = errorJson.error.message;
          } catch { /* not JSON */ }

          let errorCode = 'API_ERROR';
          if (response.status === 401) errorCode = 'AUTHENTICATION_FAILED';
          else if (response.status === 403) errorCode = 'INSUFFICIENT_PRIVILEGES';
          else if (response.status === 404) errorCode = 'NOT_FOUND';
          else if (response.status === 400) errorCode = 'INVALID_REQUEST';
          else if (response.status === 429) errorCode = 'RATE_LIMITED';

          throw new ServiceNowError(errorMessage, errorCode);
        }

        this.hooks?.onResponse?.({ url, status: response.status, durationMs: Date.now() - startedAt });
        const data = await response.json();
        return data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (error instanceof ServiceNowError) {
          if (['AUTHENTICATION_FAILED', 'INVALID_REQUEST', 'NOT_FOUND'].includes(error.code)) throw error;
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          this.hooks?.onRetry?.({ url, attempt: attempt + 1, delayMs: delay, error: lastError.message });
          logger.warn(`Request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    if (lastError) {
      const cause = (lastError as Error & { cause?: Error }).cause;
      if (cause) {
        throw new ServiceNowError(
          `Request failed: ${cause.message}`,
          (cause as Error & { code?: string }).code || 'NETWORK_ERROR'
        );
      }
      throw lastError;
    }
    throw new Error('Request failed after retries');
  }

  // ─── Table API ─────────────────────────────────────────────────────────────

  async queryRecords(params: QueryRecordsParams): Promise<QueryRecordsResponse> {
    validateTableName(params.table);
    if (params.query) validateQuery(params.query);
    await this.authenticate();

    const queryParams = new URLSearchParams();
    queryParams.set('sysparm_exclude_reference_link', 'true');

    if (params.query) queryParams.set('sysparm_query', params.query);
    if (params.fields) queryParams.set('sysparm_fields', params.fields);

    if (params.limit !== undefined) {
      queryParams.set('sysparm_limit', Math.min(params.limit, 1000).toString());
    } else {
      queryParams.set('sysparm_limit', '10');
    }

    if (params.offset !== undefined) queryParams.set('sysparm_offset', params.offset.toString());

    if (params.orderBy) {
      if (params.orderBy.startsWith('-')) {
        const field = params.orderBy.substring(1);
        queryParams.set('sysparm_query',
          params.query ? `${params.query}^ORDERBYDESC${field}` : `ORDERBYDESC${field}`
        );
      } else {
        queryParams.set('sysparm_query',
          params.query ? `${params.query}^ORDERBY${params.orderBy}` : `ORDERBY${params.orderBy}`
        );
      }
    }

    const url = `${this.baseUrl}/api/now/table/${params.table}?${queryParams.toString()}`;
    logger.info(`Querying table: ${params.table}`);

    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, records: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(
        `Failed to query records: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'QUERY_FAILED'
      );
    }
  }

  async getTableSchema(tableName: string): Promise<{ table: string; columns: Array<{ element: string; value_sample: unknown }> }> {
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/table/${tableName}?sysparm_exclude_reference_link=true&sysparm_limit=1`;
    logger.info(`Getting schema for table: ${tableName}`);

    try {
      const response = await this.request<ServiceNowApiResponse<any[]>>(url);
      if (response.result && response.result.length > 0) {
        const sample = response.result[0];
        return { table: tableName, columns: Object.keys(sample).map(key => ({ element: key, value_sample: sample[key] })) };
      }
      // Empty table — fall back to the real dictionary so callers still get columns.
      try {
        const dict = await this.getDictionary(tableName);
        return { table: tableName, columns: dict.columns.map((c) => ({ element: c.element, value_sample: null })) };
      } catch {
        return { table: tableName, columns: [] };
      }
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get table schema: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  /** Resolve the table inheritance chain (leaf first, then parents) via sys_db_object.super_class. */
  private async getTableHierarchy(tableName: string): Promise<string[]> {
    const chain: string[] = [tableName];
    let current = tableName;
    // Bounded walk to avoid pathological loops.
    for (let i = 0; i < 12; i++) {
      const url = `${this.baseUrl}/api/now/table/sys_db_object?sysparm_query=${encodeURIComponent(`name=${current}`)}&sysparm_fields=super_class.name&sysparm_exclude_reference_link=true&sysparm_limit=1&sysparm_display_value=all`;
      const resp = await this.request<ServiceNowApiResponse<any[]>>(url);
      const row = resp.result?.[0];
      const parent = row ? ((row['super_class.name'] && typeof row['super_class.name'] === 'object') ? row['super_class.name'].value : row['super_class.name']) : '';
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /**
   * Return the real column dictionary for a table from `sys_dictionary` —
   * type, label, mandatory, read-only, reference target, max length, default.
   * Includes inherited columns from parent tables (resolved via the table hierarchy).
   */
  async getDictionary(tableName: string): Promise<TableDictionary> {
    validateTableName(tableName);
    await this.authenticate();
    const fields = 'element,column_label,internal_type,max_length,mandatory,read_only,reference,default_value';
    let hierarchy: string[] = [tableName];
    try {
      hierarchy = await this.getTableHierarchy(tableName);
    } catch { /* fall back to leaf-only */ }
    const query = `${hierarchy.map((t) => `name=${t}`).join('^OR')}^elementISNOTEMPTY`;
    const url = `${this.baseUrl}/api/now/table/sys_dictionary?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${encodeURIComponent(fields + ',internal_type.name,reference.name')}&sysparm_exclude_reference_link=true&sysparm_limit=2000&sysparm_display_value=all`;
    logger.info(`Getting dictionary for table: ${tableName} (hierarchy: ${hierarchy.join(' < ')})`);
    try {
      const response = await this.request<ServiceNowApiResponse<any[]>>(url);
      const rows = response.result || [];
      const columns: DictionaryColumn[] = rows.map((r) => {
        const val = (f: string) => (r[f] && typeof r[f] === 'object' ? r[f].value : r[f]) ?? '';
        const disp = (f: string) => (r[f] && typeof r[f] === 'object' ? r[f].display_value : r[f]) ?? '';
        const maxLen = Number(val('max_length'));
        return {
          element: String(val('element')),
          column_label: String(disp('column_label') || val('column_label')),
          internal_type: String(disp('internal_type') || val('internal_type')),
          max_length: Number.isFinite(maxLen) && maxLen > 0 ? maxLen : null,
          mandatory: String(val('mandatory')) === 'true',
          read_only: String(val('read_only')) === 'true',
          reference: val('reference') ? String(disp('reference') || val('reference')) : null,
          default_value: val('default_value') ? String(val('default_value')) : null,
        };
      }).filter((c) => c.element);
      // Dedupe by element — a child table's override wins over the inherited parent row.
      const byElement = new Map<string, DictionaryColumn>();
      for (const col of columns) {
        if (!byElement.has(col.element)) byElement.set(col.element, col);
      }
      return { table: tableName, columns: Array.from(byElement.values()) };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get dictionary: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  /**
   * Async iterator that yields every record matching the query, transparently
   * following pagination via sysparm_offset. Avoids the silent 1000-row cap of
   * a single queryRecords() call.
   */
  async *iterateRecords(params: QueryRecordsParams, pageSize = 1000): AsyncGenerator<ServiceNowRecord, void, unknown> {
    let offset = params.offset ?? 0;
    const hardLimit = params.limit;
    let yielded = 0;
    for (;;) {
      const remaining = hardLimit !== undefined ? hardLimit - yielded : pageSize;
      if (remaining <= 0) return;
      const batchSize = Math.min(pageSize, remaining);
      const { records } = await this.queryRecords({ ...params, limit: batchSize, offset });
      if (records.length === 0) return;
      for (const rec of records) {
        yield rec;
        yielded++;
        if (hardLimit !== undefined && yielded >= hardLimit) return;
      }
      if (records.length < batchSize) return; // last page
      offset += records.length;
    }
  }

  /** Collect every matching record into an array (uses iterateRecords under the hood). */
  async getAllRecords(params: QueryRecordsParams, pageSize = 1000): Promise<ServiceNowRecord[]> {
    const all: ServiceNowRecord[] = [];
    for await (const rec of this.iterateRecords(params, pageSize)) all.push(rec);
    return all;
  }

  async getRecord(table: string, sysId: string, fields?: string): Promise<ServiceNowRecord> {
    validateTableName(table);
    validateSysId(sysId);
    await this.authenticate();

    const queryParams = new URLSearchParams();
    queryParams.set('sysparm_exclude_reference_link', 'true');
    if (fields) queryParams.set('sysparm_fields', fields);

    const url = `${this.baseUrl}/api/now/table/${table}/${sysId}?${queryParams.toString()}`;
    logger.info(`Getting record from ${table}: ${sysId}`);

    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord>>(url);
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get record: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async getUser(userIdentifier: string): Promise<ServiceNowRecord> {
    await this.authenticate();
    if (/^[0-9a-f]{32}$/i.test(userIdentifier)) return this.getRecord('sys_user', userIdentifier);
    const query = `user_name=${userIdentifier}^ORemail=${userIdentifier}`;
    const url = `${this.baseUrl}/api/now/table/sys_user?sysparm_query=${query}&sysparm_limit=1&sysparm_exclude_reference_link=true`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      if (response.result.length === 0) throw new ServiceNowError(`User not found: ${userIdentifier}`, 'NOT_FOUND');
      return response.result[0];
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get user: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async getGroup(groupIdentifier: string): Promise<ServiceNowRecord> {
    await this.authenticate();
    const isSysId = /^[0-9a-f]{32}$/i.test(groupIdentifier);
    const query = isSysId ? `sys_id=${groupIdentifier}` : `name=${groupIdentifier}`;
    const url = `${this.baseUrl}/api/now/table/sys_user_group?sysparm_query=${query}&sysparm_limit=1&sysparm_exclude_reference_link=true`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      if (response.result.length === 0) throw new ServiceNowError(`Group not found: ${groupIdentifier}`, 'NOT_FOUND');
      return response.result[0];
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get group: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  // ─── CMDB ──────────────────────────────────────────────────────────────────

  async searchCmdbCi(query?: string, limit: number = 10): Promise<QueryRecordsResponse> {
    await this.authenticate();
    const queryParams = new URLSearchParams();
    if (query) queryParams.set('sysparm_query', query);
    queryParams.set('sysparm_limit', Math.min(limit, 100).toString());
    queryParams.set('sysparm_exclude_reference_link', 'true');
    const url = `${this.baseUrl}/api/now/table/cmdb_ci?${queryParams.toString()}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, records: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to search CMDB CIs: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async getCmdbCi(ciSysId: string, fields?: string): Promise<ServiceNowRecord> {
    return this.getRecord('cmdb_ci', ciSysId, fields);
  }

  async listRelationships(ciSysId: string): Promise<{ count: number; relationships: ServiceNowRecord[] }> {
    await this.authenticate();
    const query = `parent=${ciSysId}^ORchild=${ciSysId}`;
    const url = `${this.baseUrl}/api/now/table/cmdb_rel_ci?sysparm_query=${query}&sysparm_exclude_reference_link=true`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, relationships: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to list relationships: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async cmdbHealthDashboard(): Promise<any> {
    await this.authenticate();
    try {
      const serversUrl = `${this.baseUrl}/api/now/table/cmdb_ci_server?sysparm_fields=sys_id,ip_address,os,serial_number&sysparm_exclude_reference_link=true`;
      const serversResponse = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(serversUrl);
      const servers = serversResponse.result;
      const serversWithIp = servers.filter(s => s.ip_address).length;
      const serversWithOs = servers.filter(s => s.os).length;
      const serversWithSerial = servers.filter(s => s.serial_number).length;

      const networkUrl = `${this.baseUrl}/api/now/table/cmdb_ci_network_adapter?sysparm_fields=sys_id,ip_address,mac_address&sysparm_limit=100&sysparm_exclude_reference_link=true`;
      const networkResponse = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(networkUrl);
      const network = networkResponse.result;
      const networkWithIp = network.filter(n => n.ip_address).length;
      const networkWithMac = network.filter(n => n.mac_address).length;

      return {
        server_metrics: {
          total: servers.length, with_ip: serversWithIp, with_os: serversWithOs, with_serial: serversWithSerial,
          ip_completeness: servers.length > 0 ? ((serversWithIp / servers.length) * 100).toFixed(2) : '0',
          os_completeness: servers.length > 0 ? ((serversWithOs / servers.length) * 100).toFixed(2) : '0',
        },
        network_metrics: {
          total: network.length, with_ip: networkWithIp, with_mac: networkWithMac,
          ip_completeness: network.length > 0 ? ((networkWithIp / network.length) * 100).toFixed(2) : '0',
          mac_completeness: network.length > 0 ? ((networkWithMac / network.length) * 100).toFixed(2) : '0',
        },
      };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get CMDB health: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async serviceMappingSummary(serviceSysId: string): Promise<any> {
    await this.authenticate();
    try {
      const serviceUrl = `${this.baseUrl}/api/now/table/cmdb_ci_service/${serviceSysId}?sysparm_exclude_reference_link=true`;
      const serviceResponse = await this.request<ServiceNowApiResponse<ServiceNowRecord>>(serviceUrl);
      const relatedUrl = `${this.baseUrl}/api/now/table/cmdb_rel_ci?sysparm_query=parent=${serviceSysId}^ORchild=${serviceSysId}&sysparm_exclude_reference_link=true`;
      const relatedResponse = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(relatedUrl);
      return { service: serviceResponse.result, related_cis_count: relatedResponse.result.length, related_cis: relatedResponse.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get service mapping: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  // ─── ITOM ──────────────────────────────────────────────────────────────────

  async listDiscoverySchedules(activeOnly: boolean = false): Promise<{ count: number; schedules: ServiceNowRecord[] }> {
    await this.authenticate();
    const query = activeOnly ? 'active=true' : '';
    const url = `${this.baseUrl}/api/now/table/discovery_schedule${query ? '?sysparm_query=' + query : ''}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, schedules: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to list discovery schedules: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async listMidServers(activeOnly: boolean = false): Promise<{ count: number; mid_servers: ServiceNowRecord[] }> {
    await this.authenticate();
    const query = activeOnly ? 'status=Up' : '';
    const url = `${this.baseUrl}/api/now/table/ecc_agent${query ? '?sysparm_query=' + query : ''}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, mid_servers: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to list MID servers: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async listActiveEvents(query?: string, limit: number = 10): Promise<QueryRecordsResponse> {
    await this.authenticate();
    const queryParams = new URLSearchParams();
    if (query) queryParams.set('sysparm_query', query);
    queryParams.set('sysparm_limit', limit.toString());
    queryParams.set('sysparm_exclude_reference_link', 'true');
    const url = `${this.baseUrl}/api/now/table/em_event?${queryParams.toString()}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord[]>>(url);
      return { count: response.result.length, records: response.result };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to list events: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async createRecord(table: string, data: Record<string, any>): Promise<ServiceNowRecord> {
    validateTableName(table);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/table/${table}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord>>(url, { method: 'POST', body: JSON.stringify(data) });
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to create record in ${table}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'CREATE_FAILED');
    }
  }

  async updateRecord(table: string, sysId: string, data: Record<string, any>): Promise<ServiceNowRecord> {
    validateTableName(table);
    validateSysId(sysId);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/table/${table}/${sysId}`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord>>(url, { method: 'PATCH', body: JSON.stringify(data) });
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to update record ${sysId} in ${table}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'UPDATE_FAILED');
    }
  }

  async deleteRecord(table: string, sysId: string): Promise<void> {
    validateTableName(table);
    validateSysId(sysId);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/table/${table}/${sysId}`;
    try {
      await this.request<void>(url, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to delete record ${sysId} from ${table}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'DELETE_FAILED');
    }
  }

  async createChangeRequest(params: any): Promise<ServiceNowRecord> {
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/table/change_request`;
    try {
      const response = await this.request<ServiceNowApiResponse<ServiceNowRecord>>(url, { method: 'POST', body: JSON.stringify(params) });
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to create change request: ${error instanceof Error ? error.message : 'Unknown error'}`, 'CREATE_FAILED');
    }
  }

  // ─── Advanced ──────────────────────────────────────────────────────────────

  async callNowAssist(endpoint: string, payload: Record<string, any>): Promise<any> {
    await this.authenticate();
    const url = `${this.baseUrl}${endpoint}`;
    try {
      return await this.request<any>(url, { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Now Assist call failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'NOW_ASSIST_ERROR');
    }
  }

  /**
   * Run an aggregate (stats) query.
   * @param aggregate One of `COUNT`, or `AVG:field` / `SUM:field` / `MIN:field` / `MAX:field`.
   *                  COUNT and a metric can be combined by passing e.g. `COUNT,AVG:duration`.
   * @param groupBy   Field(s) to group by — comma-separated for multiple groupings. Pass '' for no grouping.
   * @param opts      Optional `having` clause (e.g. `COUNT>5`).
   */
  async runAggregateQuery(
    table: string,
    groupBy: string,
    aggregate: string = 'COUNT',
    query?: string,
    opts?: { having?: string }
  ): Promise<any> {
    await this.authenticate();
    const params = new URLSearchParams();
    if (groupBy) params.set('sysparm_group_by', groupBy);
    if (query) params.set('sysparm_query', query);
    if (opts?.having) params.set('sysparm_having', opts.having);

    // Parse the requested aggregate(s) into the matching stats params.
    const fieldBuckets: Record<string, string[]> = { avg: [], sum: [], min: [], max: [] };
    let wantCount = false;
    for (const part of aggregate.split(',').map((p) => p.trim()).filter(Boolean)) {
      const [fnRaw, field] = part.split(':').map((s) => s.trim());
      const fn = fnRaw.toLowerCase();
      if (fn === 'count') { wantCount = true; continue; }
      if (field && fn in fieldBuckets) { fieldBuckets[fn].push(field); continue; }
      // Unknown spec — default to count so the call still returns something useful.
      wantCount = true;
    }
    if (wantCount || (!fieldBuckets.avg.length && !fieldBuckets.sum.length && !fieldBuckets.min.length && !fieldBuckets.max.length)) {
      params.set('sysparm_count', 'true');
    }
    if (fieldBuckets.avg.length) params.set('sysparm_avg_fields', fieldBuckets.avg.join(','));
    if (fieldBuckets.sum.length) params.set('sysparm_sum_fields', fieldBuckets.sum.join(','));
    if (fieldBuckets.min.length) params.set('sysparm_min_fields', fieldBuckets.min.join(','));
    if (fieldBuckets.max.length) params.set('sysparm_max_fields', fieldBuckets.max.join(','));

    const url = `${this.baseUrl}/api/now/stats/${table}?${params.toString()}`;
    try {
      const response = await this.request<any>(url);
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Aggregate query failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  /** Return the number of records matching an (optional) encoded query — a single lightweight stats call. */
  async getRecordCount(table: string, query?: string): Promise<number> {
    await this.authenticate();
    const params = new URLSearchParams();
    params.set('sysparm_count', 'true');
    if (query) params.set('sysparm_query', query);
    const url = `${this.baseUrl}/api/now/stats/${table}?${params.toString()}`;
    try {
      const response = await this.request<any>(url);
      const stats = response.result?.stats ?? response.result;
      const count = Number(stats?.count ?? 0);
      return Number.isFinite(count) ? count : 0;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Count query failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  async naturalLanguageSearch(query: string, limit: number = 10): Promise<any> {
    const searchQuery = `short_descriptionLIKE${query}^ORdescriptionLIKE${query}`;
    return this.queryRecords({ table: 'incident', query: searchQuery, limit });
  }

  async uploadAttachment(
    table: string, recordSysId: string, fileName: string, contentType: string, contentBase64: string
  ): Promise<any> {
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/attachment/file?table_name=${encodeURIComponent(table)}&table_sys_id=${encodeURIComponent(recordSysId)}&file_name=${encodeURIComponent(fileName)}`;
    try {
      const binary = bytesFromBase64(contentBase64);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Authorization': this.getAuthHeader(), 'Accept': 'application/json' },
        body: binary as unknown as BodyInit,
      });
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try { const j = JSON.parse(errorText); if (j.error?.message) errorMessage = j.error.message; } catch { /* */ }
        throw new ServiceNowError(errorMessage, 'ATTACHMENT_UPLOAD_FAILED');
      }
      const data = await response.json() as any;
      return data.result ?? data;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to upload attachment: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ATTACHMENT_UPLOAD_FAILED');
    }
  }

  /** List attachment metadata for a record. */
  async listAttachments(table: string, recordSysId: string): Promise<AttachmentMeta[]> {
    validateTableName(table);
    validateSysId(recordSysId);
    await this.authenticate();
    const query = `table_name=${table}^table_sys_id=${recordSysId}`;
    const url = `${this.baseUrl}/api/now/attachment?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=1000`;
    try {
      const response = await this.request<ServiceNowApiResponse<AttachmentMeta[]>>(url);
      return response.result || [];
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to list attachments: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ATTACHMENT_LIST_FAILED');
    }
  }

  /** Download an attachment's bytes as base64 (with its metadata). */
  async getAttachment(attachmentSysId: string): Promise<{ meta: AttachmentMeta; contentBase64: string }> {
    validateSysId(attachmentSysId);
    await this.authenticate();
    const metaUrl = `${this.baseUrl}/api/now/attachment/${attachmentSysId}`;
    const fileUrl = `${this.baseUrl}/api/now/attachment/${attachmentSysId}/file`;
    try {
      const metaResp = await this.request<ServiceNowApiResponse<AttachmentMeta>>(metaUrl);
      const fileResp = await fetch(fileUrl, {
        headers: { 'Authorization': this.getAuthHeader(), 'Accept': '*/*' },
      });
      if (!fileResp.ok) throw new ServiceNowError(`HTTP ${fileResp.status}: ${fileResp.statusText}`, 'ATTACHMENT_DOWNLOAD_FAILED');
      const bytes = new Uint8Array(await fileResp.arrayBuffer());
      return { meta: metaResp.result, contentBase64: base64FromBytes(bytes) };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to download attachment: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ATTACHMENT_DOWNLOAD_FAILED');
    }
  }

  /** Delete an attachment by sys_id. */
  async deleteAttachment(attachmentSysId: string): Promise<void> {
    validateSysId(attachmentSysId);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/attachment/${attachmentSysId}`;
    try {
      await this.request<void>(url, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to delete attachment: ${error instanceof Error ? error.message : 'Unknown error'}`, 'ATTACHMENT_DELETE_FAILED');
    }
  }

  // ─── Import Sets ───────────────────────────────────────────────────────────

  /**
   * Insert a row into an import set staging table, running the configured
   * transform map synchronously and returning the transform result.
   */
  async insertImportSetRow(stagingTable: string, data: Record<string, unknown>): Promise<ImportSetResult> {
    validateTableName(stagingTable);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/import/${stagingTable}`;
    try {
      const response = await this.request<ImportSetResult>(url, { method: 'POST', body: JSON.stringify(data) });
      return response;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to insert import set row: ${error instanceof Error ? error.message : 'Unknown error'}`, 'IMPORT_FAILED');
    }
  }

  /** Get the status/details of an import set by number or sys_id. */
  async getImportSetStatus(stagingTable: string, importSetSysId: string): Promise<ImportSetResult> {
    validateTableName(stagingTable);
    validateSysId(importSetSysId);
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/import/${stagingTable}/${importSetSysId}`;
    try {
      return await this.request<ImportSetResult>(url);
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get import set status: ${error instanceof Error ? error.message : 'Unknown error'}`, 'IMPORT_FAILED');
    }
  }

  // ─── Instance Metadata ───────────────────────────────────────────────────────

  /** Return basic instance version/build metadata from sys_properties. */
  async getInstanceStats(): Promise<InstanceStats> {
    await this.authenticate();
    const names = ['glide.war', 'glide.buildname', 'glide.buildtag', 'glide.builddate', 'glide.system.hostname'];
    const query = names.map((n) => `name=${n}`).join('^OR');
    const url = `${this.baseUrl}/api/now/table/sys_properties?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=name,value&sysparm_limit=50`;
    try {
      const response = await this.request<ServiceNowApiResponse<Array<{ name: string; value: string }>>>(url);
      const map: Record<string, string> = {};
      for (const row of response.result || []) map[row.name] = row.value;
      return {
        instanceUrl: this.baseUrl,
        version: map['glide.war'] || null,
        buildName: map['glide.buildname'] || null,
        buildTag: map['glide.buildtag'] || null,
        buildDate: map['glide.builddate'] || null,
        nodeName: map['glide.system.hostname'] || null,
      };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get instance stats: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
  }

  // ─── Batch API ─────────────────────────────────────────────────────────────

  /**
   * Execute multiple REST API calls in a single round-trip.
   * Uses ServiceNow's /api/now/v1/batch endpoint for 56-66% fewer network calls.
   *
   * @example
   * const results = await client.batch([
   *   { method: 'GET', url: '/api/now/table/incident?sysparm_limit=5' },
   *   { method: 'GET', url: '/api/now/stats/incident?sysparm_count=true' },
   * ]);
   */
  async batch(requests: BatchRequestItem[]): Promise<BatchResponseItem[]> {
    await this.authenticate();
    const url = `${this.baseUrl}/api/now/v1/batch`;

    // ServiceNow caps batches at 50 operations — transparently chunk larger sets.
    const CHUNK = 50;
    if (requests.length > CHUNK) {
      logger.info(`Auto-chunking ${requests.length} operations into batches of ${CHUNK}`);
      const all: BatchResponseItem[] = [];
      for (let i = 0; i < requests.length; i += CHUNK) {
        const chunk = requests.slice(i, i + CHUNK);
        const payload = buildBatchPayload(chunk);
        const response = await this.request<any>(url, { method: 'POST', body: JSON.stringify(payload) });
        all.push(...parseBatchResponse(response));
      }
      return all;
    }

    const payload = buildBatchPayload(requests);
    logger.info(`Executing batch request with ${requests.length} operations`);
    try {
      const response = await this.request<any>(url, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return parseBatchResponse(response);
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(
        `Batch request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'API_ERROR'
      );
    }
  }

  /**
   * Alias for batch() — matches the MCP tool naming convention.
   */
  async batchRequest(operations: Array<{ id: string; method: string; url: string; body?: any }>): Promise<any> {
    const requests: BatchRequestItem[] = operations.map(op => ({
      method: op.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: op.url,
      body: op.body,
    }));

    const results = await this.batch(requests);
    return {
      batch_id: `nowaikit_${Date.now()}`,
      total: operations.length,
      results: results.map((r, i) => ({
        id: operations[i].id,
        status_code: r.status_code,
        body: r.body,
      })),
    };
  }

  /**
   * Execute a server-side script via Background Script / Batch API.
   */
  async executeScript(script: string, scope?: string): Promise<any> {
    await this.authenticate();
    logger.info('Executing server-side script');

    try {
      const response = await this.request<any>(
        `${this.baseUrl}/api/now/v1/batch`,
        {
          method: 'POST',
          body: JSON.stringify({
            batch_request_id: `script_${Date.now()}`,
            rest_requests: [{
              id: 'script_exec',
              method: 'POST',
              url: '/api/now/table/sys_script_execution',
              headers: [
                { name: 'Content-Type', value: 'application/json' },
                { name: 'Accept', value: 'application/json' },
              ],
              body: JSON.stringify({ script, scope: scope || 'global' }),
            }],
          }),
        }
      );

      const results = response.serviced_requests || [];
      if (results.length > 0) {
        let body: any;
        try {
          body = typeof results[0].body === 'string' ? JSON.parse(results[0].body) : results[0].body;
        } catch {
          body = results[0].body;
        }
        return { status: results[0].status_code, output: body, scope: scope || 'global' };
      }
      return { status: 200, output: 'Script executed (no output captured)', scope: scope || 'global' };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(
        `Script execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'API_ERROR'
      );
    }
  }
}
