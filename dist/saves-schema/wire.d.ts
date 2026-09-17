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
export type SaveErrorCode = "no_save" | "conflict" | "unknown_game" | "unknown_slot" | "not_found" | "method_not_allowed" | "payload_too_large" | "invalid_body" | "invalid_payload" | "denied_key" | "save_rejected" | "rate_limited" | "upstream" | "saves_unavailable" | "unauthorized" | "idempotency_key_reused";
export interface ErrorBody {
    error: SaveErrorCode;
    detail?: string;
}
