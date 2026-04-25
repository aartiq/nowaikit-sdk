// @nowaikit/sdk — Lightweight ServiceNow REST API client
// Zero MCP dependency. TypeScript-first. Native fetch.

export { ServiceNowClient } from './client.js';
export { InstanceManager } from './instances.js';
export type { InstanceEntry } from './instances.js';
export { ServiceNowError } from './errors.js';
export { validateTableName, validateSysId, validateQuery, sanitizeUrlParam } from './helpers.js';
export { buildBatchPayload, parseBatchResponse } from './batch.js';

// v2.0.0 modules
export { A2AClient } from './a2a.js';
export type { A2AClientConfig, A2AMessage, A2AAgentCard, A2ATask, A2APart } from './a2a.js';
export { streamSSE } from './streaming.js';
export type { SSEEvent } from './streaming.js';
export { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl, exchangeCodeForTokens } from './oauth-pkce.js';
export { SchemaCache } from './cache.js';
export { NowAssistClient } from './now-assist.js';
export type { NowConfig, FluentComponent, UxAppRoute, FluentDataBroker } from './fluent-types.js';

// Re-export all types
export type {
  // Core
  AuthMode,
  ServiceNowConfig,
  QueryRecordsParams,
  QueryRecordsResponse,
  ServiceNowRecord,
  ServiceNowReference,
  OAuthTokenResponse,
  ServiceNowApiResponse,
  ServiceNowApiError,
  // Batch
  BatchRequestItem,
  BatchResponseItem,
  BatchResponse,
  // Platform
  GetRecordParams,
  GetUserParams,
  GetGroupParams,
  // CMDB
  SearchCmdbCiParams,
  GetCmdbCiParams,
  ListRelationshipsParams,
  CreateCmdbCiParams,
  UpdateCmdbCiParams,
  AddCiRelationshipParams,
  // ITOM
  ListDiscoverySchedulesParams,
  ListMidServersParams,
  ListActiveEventsParams,
  ServiceMappingSummaryParams,
  CreateEventParams,
  UpdateEventParams,
  ResolveEventParams,
  // Incident
  CreateIncidentParams,
  GetIncidentParams,
  UpdateIncidentParams,
  ResolveIncidentParams,
  CloseIncidentParams,
  AddWorkNoteParams,
  AddCommentParams,
  // Problem
  CreateProblemParams,
  GetProblemParams,
  UpdateProblemParams,
  ResolveProblemParams,
  // Change
  CreateChangeRequestParams,
  GetChangeRequestParams,
  UpdateChangeRequestParams,
  ListChangeRequestsParams,
  SubmitChangeForApprovalParams,
  CloseChangeRequestParams,
  // Task
  GetTaskParams,
  UpdateTaskParams,
  ListMyTasksParams,
  CompleteTaskParams,
  // Knowledge
  ListKnowledgeBasesParams,
  SearchKnowledgeParams,
  GetKnowledgeArticleParams,
  CreateKnowledgeArticleParams,
  UpdateKnowledgeArticleParams,
  PublishKnowledgeArticleParams,
  // Catalog
  ListCatalogItemsParams,
  SearchCatalogParams,
  GetCatalogItemParams,
  OrderCatalogItemParams,
  // Approval
  GetMyApprovalsParams,
  ListApprovalsParams,
  ApproveRequestParams,
  RejectRequestParams,
  // SLA
  GetSlaDetailsParams,
  ListActiveSLAsParams,
  // Users & Groups
  ListUsersParams,
  CreateUserParams,
  UpdateUserParams,
  ListGroupsParams,
  CreateGroupParams,
  UpdateGroupParams,
  AddUserToGroupParams,
  RemoveUserFromGroupParams,
  // Reporting
  ListReportsParams,
  GetReportParams,
  RunReportParams,
  CreateReportParams,
  GetPerformanceAnalyticsParams,
  TrendQueryParams,
  RunAggregateQueryParams,
  ExportReportDataParams,
  // ATF
  ListAtfSuitesParams,
  GetAtfSuiteParams,
  RunAtfSuiteParams,
  ListAtfTestsParams,
  GetAtfTestParams,
  RunAtfTestParams,
  GetAtfSuiteResultParams,
  ListAtfTestResultsParams,
  GetAtfTestResultParams,
  GetAtfFailureInsightParams,
  ListAtfStepsParams,
  // AI
  NlqQueryParams,
  AiSearchParams,
  GenerateSummaryParams,
  SuggestResolutionParams,
  GenerateWorkNotesParams,
  CategorizeIncidentParams,
  PredictiveScoreParams,
  GetVirtualAgentTopicsParams,
  TriggerAgenticPlaybookParams,
  // Scripting
  ListBusinessRulesParams,
  GetBusinessRuleParams,
  CreateBusinessRuleParams,
  UpdateBusinessRuleParams,
  ListScriptIncludesParams,
  GetScriptIncludeParams,
  CreateScriptIncludeParams,
  UpdateScriptIncludeParams,
  ListClientScriptsParams,
  GetClientScriptParams,
  ListChangesetsParams,
  GetChangesetParams,
  CommitChangesetParams,
  PublishChangesetParams,
  // Agile
  CreateStoryParams,
  UpdateStoryParams,
  ListStoriesParams,
  CreateEpicParams,
  UpdateEpicParams,
  ListEpicsParams,
  CreateScrumTaskParams,
  UpdateScrumTaskParams,
  ListScrumTasksParams,
  // Analytics
  GetSysLogParams,
  ListScheduledJobsParams,
  // Legacy
  NaturalLanguageSearchParams,
  NaturalLanguageUpdateParams,
} from './types.js';
