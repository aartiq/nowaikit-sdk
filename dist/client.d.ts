import type { ServiceNowConfig, QueryRecordsParams, QueryRecordsResponse, ServiceNowRecord, BatchRequestItem, BatchResponseItem } from './types.js';
export declare class ServiceNowClient {
    private baseUrl;
    private authMethod;
    private authMode;
    private oauthConfig?;
    private basicConfig?;
    private maxRetries;
    private retryDelayMs;
    private requestTimeoutMs;
    private impersonateUserSysId?;
    private perUserBearerToken?;
    private accessToken?;
    private tokenExpiry?;
    constructor(config: ServiceNowConfig);
    /** Return the base instance URL. */
    getBaseUrl(): string;
    /** Return a copy configured for a specific user context. */
    withUser(options: {
        sysId?: string;
        bearerToken?: string;
    }): ServiceNowClient;
    private authenticate;
    private getAuthHeader;
    private getImpersonateHeader;
    private request;
    queryRecords(params: QueryRecordsParams): Promise<QueryRecordsResponse>;
    getTableSchema(tableName: string): Promise<{
        table: string;
        columns: Array<{
            element: string;
            value_sample: unknown;
        }>;
    }>;
    getRecord(table: string, sysId: string, fields?: string): Promise<ServiceNowRecord>;
    getUser(userIdentifier: string): Promise<ServiceNowRecord>;
    getGroup(groupIdentifier: string): Promise<ServiceNowRecord>;
    searchCmdbCi(query?: string, limit?: number): Promise<QueryRecordsResponse>;
    getCmdbCi(ciSysId: string, fields?: string): Promise<ServiceNowRecord>;
    listRelationships(ciSysId: string): Promise<{
        count: number;
        relationships: ServiceNowRecord[];
    }>;
    cmdbHealthDashboard(): Promise<any>;
    serviceMappingSummary(serviceSysId: string): Promise<any>;
    listDiscoverySchedules(activeOnly?: boolean): Promise<{
        count: number;
        schedules: ServiceNowRecord[];
    }>;
    listMidServers(activeOnly?: boolean): Promise<{
        count: number;
        mid_servers: ServiceNowRecord[];
    }>;
    listActiveEvents(query?: string, limit?: number): Promise<QueryRecordsResponse>;
    createRecord(table: string, data: Record<string, any>): Promise<ServiceNowRecord>;
    updateRecord(table: string, sysId: string, data: Record<string, any>): Promise<ServiceNowRecord>;
    deleteRecord(table: string, sysId: string): Promise<void>;
    createChangeRequest(params: any): Promise<ServiceNowRecord>;
    callNowAssist(endpoint: string, payload: Record<string, any>): Promise<any>;
    runAggregateQuery(table: string, groupBy: string, _aggregate?: string, query?: string): Promise<any>;
    naturalLanguageSearch(query: string, limit?: number): Promise<any>;
    uploadAttachment(table: string, recordSysId: string, fileName: string, contentType: string, contentBase64: string): Promise<any>;
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
    batch(requests: BatchRequestItem[]): Promise<BatchResponseItem[]>;
    /**
     * Alias for batch() — matches the MCP tool naming convention.
     */
    batchRequest(operations: Array<{
        id: string;
        method: string;
        url: string;
        body?: any;
    }>): Promise<any>;
    /**
     * Execute a server-side script via Background Script / Batch API.
     */
    executeScript(script: string, scope?: string): Promise<any>;
}
//# sourceMappingURL=client.d.ts.map