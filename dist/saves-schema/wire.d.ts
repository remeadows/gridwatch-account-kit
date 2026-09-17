export declare const MAX_BODY_BYTES = 65536;
export declare const UUID_RE: RegExp;
export declare const SLOT_RE: RegExp;
export declare const ALIAS_RE: RegExp;
export type SavePayload = Record<string, unknown>;
export interface SaveRow {
    slot: string;
    schemaVersion: number;
    revision: number;
    payload: SavePayload;
    updatedAt: string;
}
export interface StoreRequest {
    schemaVersion: number;
    baseRevision: number;
    payload: SavePayload;
    deviceId: string;
    idempotencyKey: string;
}
export interface StoreOk {
    revision: number;
    updatedAt: string;
}
export interface CloudSummary {
    schemaVersion: number;
    sizeBytes: number;
    payloadDigest: string;
    deviceId: string | null;
}
export interface ConflictBody {
    error: "conflict";
    cloud: {
        revision: number;
        updatedAt: string;
        summary: CloudSummary;
    };
}
export interface ErrorBody {
    error: string;
    detail?: string;
}
