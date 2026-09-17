export type { SaveGameConfig, SavesClient, LoadResult, StoreResult, ReconcileResult, CloudSave, SaveError } from "./types.js";
export { CONFLICT_COPY, OWNERSHIP_COPY } from "./prompt.js";
export { createSavesClient, type SavesClientDeps } from "./client.js";
