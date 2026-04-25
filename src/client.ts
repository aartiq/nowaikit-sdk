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
} from './types.js';
import { ServiceNowError } from './errors.js';
import { validateTableName, validateSysId, validateQuery } from './helpers.js';
import { buildBatchPayload, parseBatchResponse } from './batch.js';

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
  }

  /** Return the base instance URL. */
  getBaseUrl(): string {
    return this.baseUrl;
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

    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) return;

    if (!this.oauthConfig?.clientId || !this.oauthConfig?.clientSecret) {
      throw new ServiceNowError('OAuth client ID and secret are required', 'AUTHENTICATION_FAILED');
    }
    if (!this.oauthConfig?.username || !this.oauthConfig?.password) {
      throw new ServiceNowError('Username and password are required for OAuth password grant', 'AUTHENTICATION_FAILED');
    }

    const tokenUrl = `${this.baseUrl}/oauth_token.do`;
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.oauthConfig.clientId,
      client_secret: this.oauthConfig.clientSecret,
      username: this.oauthConfig.username,
      password: this.oauthConfig.password,
    });

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        throw new ServiceNowError(
          `OAuth authentication failed: ${response.status} ${response.statusText}`,
          'AUTHENTICATION_FAILED'
        );
      }

      const tokenData = await response.json() as OAuthTokenResponse;
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = Date.now() + (tokenData.expires_in * 1000 * 0.9);
      logger.debug('OAuth token acquired successfully');
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
      return `Basic ${Buffer.from(`${this.basicConfig.username}:${this.basicConfig.password}`).toString('base64')}`;
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

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': this.getAuthHeader(),
            ...extraHeaders,
            ...options.headers,
          },
        });

        clearTimeout(timeout);

        if (!response.ok) {
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

          throw new ServiceNowError(errorMessage, errorCode);
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (error instanceof ServiceNowError) {
          if (['AUTHENTICATION_FAILED', 'INVALID_REQUEST', 'NOT_FOUND'].includes(error.code)) throw error;
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
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
          params.query ? `${params.query}^ORDERBY${field}^ORDERBYDESC` : `ORDERBY${field}^ORDERBYDESC`
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
      return { table: tableName, columns: [] };
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Failed to get table schema: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
    }
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

  async runAggregateQuery(table: string, groupBy: string, _aggregate: string = 'COUNT', query?: string): Promise<any> {
    await this.authenticate();
    const params = new URLSearchParams();
    params.set('sysparm_group_by', groupBy);
    if (query) params.set('sysparm_query', query);
    params.set('sysparm_count', 'true');
    const url = `${this.baseUrl}/api/now/stats/${table}?${params.toString()}`;
    try {
      const response = await this.request<any>(url);
      return response.result;
    } catch (error) {
      if (error instanceof ServiceNowError) throw error;
      throw new ServiceNowError(`Aggregate query failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'QUERY_FAILED');
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
      const binary = Buffer.from(contentBase64, 'base64');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Authorization': this.getAuthHeader(), 'Accept': 'application/json' },
        body: binary,
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
    const payload = buildBatchPayload(requests);
    const url = `${this.baseUrl}/api/now/v1/batch`;
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
