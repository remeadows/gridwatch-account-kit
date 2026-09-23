import type { SavePayload } from "../saves-schema/wire.js";
export interface SaveGameConfig {
    gameSlug: string;
    routeAlias: string;
    slots: readonly string[];
    schemaVersion: number;
    /** Spec §6: exact https origins (or a loopback http origin, for local e2e only) allowed to hand
     *  this game's local save to Nexus. Checked by createAccountKit. */
    carryFrom?: readonly string[];
}
export interface CloudSave {
    revision: number;
    schemaVersion: number;
    payload: SavePayload;
    updatedAt: string;
}
export interface SaveError {
    code: "network" | "http" | "invalid_payload" | "upstream";
    status?: number;
    message: string;
}
export type LoadResult = {
    status: "ok";
    save: CloudSave;
} | {
    status: "none";
} | {
    status: "signed_out";
} | {
    status: "error";
    error: SaveError;
};
export type StoreResult = {
    status: "stored";
    revision: number;
    updatedAt: string;
} | {
    status: "use_cloud";
    save: CloudSave;
} | {
    status: "signed_out";
} | {
    status: "error";
    error: SaveError;
};
export type ReconcileResult = {
    status: "signed_out";
} | {
    status: "nothing";
} | {
    status: "uploaded";
    revision: number;
} | {
    status: "use_cloud";
    save: CloudSave;
} | {
    status: "current";
} | {
    status: "fresh";
} | {
    status: "stored";
    revision: number;
} | {
    status: "error";
    error: SaveError;
};
export interface ReconcileOptions {
    /** The game knows this slot's local payload has changes that were never confirmed in the
     *  cloud (e.g. edits made while signed out). */
    localChanged?: boolean;
    /** Re-read at decision time, after the cloud row is known. If it returns a payload that differs
     *  from the one passed to reconcile(), the fresh value is what the kit decides on and sends, and
     *  the call is treated as `localChanged: true`. Must be synchronous and must not throw. */
    current?: () => SavePayload | null;
}
export interface SavesClient {
    readonly game: SaveGameConfig;
    load(slot: string): Promise<LoadResult>;
    store(slot: string, payload: SavePayload): Promise<StoreResult>;
    reconcile(slot: string, localPayload: SavePayload | null, options?: ReconcileOptions): Promise<ReconcileResult>;
    /** Tears the client down. Through createAccountKit the prompt host is shared with kit.carry, so
     *  this also closes an open carry replace prompt: its askReplace() then answers false. */
    dispose(): void;
}
