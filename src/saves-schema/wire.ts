// Wire contract for /api/saves (spec §3.2 + §5.3). Shared by the Nexus worker and the kit client.
export const MAX_BODY_BYTES = 65536;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ALIAS_RE = /^[a-z]{1,16}$/;

export type SavePayload = Record<string, unknown>;
export interface SaveRow { slot: string; schemaVersion: number; revision: number; payload: SavePayload; updatedAt: string }
export interface StoreRequest { schemaVersion: number; baseRevision: number; payload: SavePayload; deviceId: string; idempotencyKey: string }
export interface StoreOk { revision: number; updatedAt: string }
export interface CloudSummary { schemaVersion: number; sizeBytes: number; payloadDigest: string; deviceId: string | null }
export interface ConflictBody { error: "conflict"; cloud: { revision: number; updatedAt: string; summary: CloudSummary } }
export interface ErrorBody { error: string; detail?: string }
