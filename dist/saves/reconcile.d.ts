import type { SavePayload } from "../saves-schema/wire.js";
import type { SyncRecord } from "./state.js";
import type { CloudSave } from "./types.js";
export interface ReconcileInputs {
    signedIn: boolean;
    cloud: CloudSave | null;
    local: SavePayload | null;
    record: SyncRecord | null;
    owner: string | null;
    userId: string | null;
}
export type ReconcileDecision = "signed_out" | "nothing" | "upload" | "ownership_prompt" | "use_cloud" | "conflict_prompt" | "current" | "restore_dirty";
/** Spec §5.4 decision table. Revisions decide, never timestamps. Pure: no I/O, no DOM. */
export declare function decideReconcile(inputs: ReconcileInputs): ReconcileDecision;
