export type { SaveGameConfig, SavesClient, LoadResult, StoreResult, ReconcileResult, CloudSave, SaveError } from "./types.js";
export { CONFLICT_COPY, OWNERSHIP_COPY, createDomPromptHost, type PromptHost, type PromptCopy, type PromptAnswer } from "./prompt.js";
export { createSavesClient, type SavesClientDeps } from "./client.js";
export { createSaveStateStore, type SaveStateStore, type SyncRecord } from "./state.js";
export { createTransport, withRetry, type Transport, type TransportResult } from "./transport.js";
export { decideReconcile, type ReconcileDecision, type ReconcileInputs } from "./reconcile.js";
