// Wire contract for /api/saves (spec §3.2 + §5.3). Shared by the Nexus worker and the kit client.
export const MAX_BODY_BYTES = 65536;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ALIAS_RE = /^[a-z]{1,16}$/;

export type SavePayload = Record<string, unknown>;
export interface SaveRow { slot: string; schemaVersion: number; revision: number; payload: SavePayload; updatedAt: string }
export interface StoreRequest { schemaVersion: number; baseRevision: number; payload: SavePayload; deviceId: string; idempotencyKey: string }
export interface StoreOk { revision: number; updatedAt: string }
export interface CloudSummary {
  /** `null` when the server reports a conflict with no cloud row to summarize. */
  schemaVersion: number | null;
  sizeBytes: number;
  payloadDigest: string;
  deviceId: string | null;
}
export interface ConflictBody { error: "conflict"; cloud: { revision: number; updatedAt: string; summary: CloudSummary } }
export type SaveErrorCode =
  | "no_save" | "conflict" | "unknown_game" | "unknown_slot" | "not_found" | "method_not_allowed"
  | "payload_too_large" | "invalid_body" | "invalid_payload" | "denied_key" | "save_rejected"
  | "rate_limited" | "upstream" | "saves_unavailable" | "unauthorized" | "idempotency_key_reused";
export interface ErrorBody { error: SaveErrorCode; detail?: string }
