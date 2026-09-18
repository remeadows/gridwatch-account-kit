import type { SavePayload } from "../saves-schema/wire.js";
export interface SaveGameConfig {
    gameSlug: string;
    routeAlias: string;
    slots: readonly string[];
    schemaVersion: number;
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
}
export interface SavesClient {
    readonly game: SaveGameConfig;
    load(slot: string): Promise<LoadResult>;
    store(slot: string, payload: SavePayload): Promise<StoreResult>;
    reconcile(slot: string, localPayload: SavePayload | null, options?: ReconcileOptions): Promise<ReconcileResult>;
    dispose(): void;
}
