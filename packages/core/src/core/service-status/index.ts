/**
 * Upstream service-status subsystem (#182).
 *
 * This module is the whole public surface. #183 (the Discord card) and #184
 * (the MCP tools) are expected to consume it read-only:
 *
 *   - `ServiceStatusStore#listSnapshots` / `#getSnapshot` for current state,
 *   - `#listIncidents` / `#listEvents` for bounded history,
 *   - `ServiceStatusRefreshManager#refreshSource` / `#refresh` for an operator
 *     or tool-triggered refresh, whose result distinguishes what was executed
 *     from what was coalesced or rate limited,
 *   - `onUpdate` for push-style redraws.
 *
 * Neither consumer is implemented here.
 */
export {
  SERVICE_STATUS_DEFAULTS,
  SERVICE_STATUS_EVENT_KINDS,
  SERVICE_STATUS_LEVELS,
  SERVICE_OBSERVATION_HEALTHS,
  SERVICE_SOURCE_PROVENANCES,
  INCIDENT_STAGES,
  INCIDENT_RESOLUTION_SOURCES,
  HISTORY_RETENTION_MS,
  type IncidentResolutionSource,
  type IncidentStage,
  type NewServiceStatusEvent,
  type NormalizedBaseline,
  type NormalizedComponent,
  type NormalizedIncident,
  type NormalizedIncidentUpdate,
  type ServiceObservation,
  type ServiceObservationHealth,
  type ServiceSourceProvenance,
  type ServiceStatusAdapterContext,
  type ServiceStatusAdapterResult,
  type ServiceStatusComponent,
  type ServiceStatusEvent,
  type ServiceStatusEventKind,
  type ServiceStatusIncident,
  type ServiceStatusLevel,
  type ServiceStatusSnapshot,
  type ServiceStatusSourceDefinition,
} from "./types.js";

export { COMPONENT_REMOVED } from "./types.js";
export { computeEffectiveStatus, isServiceStatusLevel, statusRank, worstStatus } from "./severity.js";
export { diffSnapshots, incidentSignature } from "./events.js";
export { sanitizeErrorMessage, ServiceStatusFetchError, ServiceStatusSchemaError } from "./http.js";
export { validateAdapterResult } from "./validate.js";

export {
  ServiceStatusStore,
  resolveQueryLimit,
  type EventQuery,
  type IncidentQuery,
  type RecordFailureInput,
  type RecordOutcome,
  type RecordSuccessInput,
  type RegisteredSource,
  type ServiceStatusStoreOptions,
} from "./store.js";

export {
  ServiceStatusRefreshManager,
  aggregateOutcome,
  backoffDelayMs,
  type RefreshDisposition,
  type RefreshOptions,
  type RefreshOutcome,
  type RefreshResult,
  type ServiceStatusLoggerLike,
  type ServiceStatusManagerOptions,
  type ServiceStatusTimers,
  type SourceRefreshResult,
} from "./manager.js";

export {
  createDefaultServiceStatusSources,
  ANTHROPIC_COMPONENT_IDS,
  GITHUB_COMPONENT_IDS,
  GOOGLE_CLOUD_PRODUCT_IDS,
  OPENAI_COMPONENT_IDS,
} from "./sources/registry.js";
export { createStatuspageAdapter, normalizeStatuspage, mergeIncidents } from "./sources/statuspage.js";
export { createXaiAdapter, normalizeXaiFeed, XAI_FEED_URL } from "./sources/xai.js";
export {
  createGoogleCloudAdapter,
  normalizeGoogleCloud,
  GOOGLE_CLOUD_INCIDENTS_URL,
  GOOGLE_CLOUD_PRODUCTS_URL,
} from "./sources/google-cloud.js";
export {
  createGoogleAiStudioAdapter,
  discoverBootstrapCandidates,
  normalizeAlkaliHistory,
  AI_STUDIO_BOOTSTRAP_URL,
  AI_STUDIO_RPC_URL,
} from "./sources/google-ai-studio.js";
export {
  createLinkworksAdapter,
  normalizeLinkworksDashboard,
  LINKWORKS_LIVE_URL,
} from "./sources/linkworks.js";

export {
  ServiceStatusMcpView,
  createServiceStatusMcpView,
  SERVICE_STATUS_VIEW_LIMITS,
  type ServiceStatusComponentView,
  type ServiceStatusHistoryView,
  type ServiceStatusIncidentUpdateView,
  type ServiceStatusIncidentView,
  type ServiceStatusMcpViewOptions,
  type ServiceStatusObservationView,
  type ServiceStatusReadOptions,
  type ServiceStatusReadResult,
  type ServiceStatusRefreshOptions,
  type ServiceStatusRefreshResult,
  type ServiceStatusRefreshSourceView,
  type ServiceStatusSourceView,
} from "./mcp-view.js";
