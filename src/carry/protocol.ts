// Spec §6.2: the ready → offer → result hand-off between an old game hostname and Nexus.
import { canonicalJson } from "../saves-schema/canonical.js";
import { validatePayload } from "../saves-schema/games.js";
import { MAX_BODY_BYTES, type SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";

export const CARRY_HASH = "#gw-carry";
export const READY_TIMEOUT_MS = 20_000;
export const OFFER_TIMEOUT_MS = 20_000;
export const CLOSED_POLL_MS = 1_000;

export type CarryStatus = "accepted" | "declined" | "rejected";
interface Envelope { gw: "carry"; v: 1; id: string }
export interface ReadyMessage extends Envelope { type: "ready" }
export interface OfferMessage extends Envelope {
  type: "offer"; gameSlug: string; schemaVersion: number; slots: Record<string, SavePayload>; exportedAt: string;
}
export interface ResultMessage extends Envelope { type: "result"; status: CarryStatus; detail?: string }
export type CarryMessage = ReadyMessage | OfferMessage | ResultMessage;
export type OfferCheck = { ok: true; slots: Record<string, SavePayload> } | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural read of an incoming message. Anything that is not exactly one of the three shapes is null. */
export function readCarryMessage(data: unknown): CarryMessage | null {
  if (!isRecord(data) || data.gw !== "carry" || data.v !== 1) return null;
  const id = data.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  switch (data.type) {
    case "ready":
      return { gw: "carry", v: 1, type: "ready", id };
    case "offer": {
      const { gameSlug, schemaVersion, slots, exportedAt } = data;
      if (typeof gameSlug !== "string" || typeof schemaVersion !== "number" || !isRecord(slots) || typeof exportedAt !== "string") return null;
      return { gw: "carry", v: 1, type: "offer", id, gameSlug, schemaVersion, slots: slots as Record<string, SavePayload>, exportedAt };
    }
    case "result": {
      const status = data.status;
      if (status !== "accepted" && status !== "declined" && status !== "rejected") return null;
      const message: ResultMessage = { gw: "carry", v: 1, type: "result", id, status };
      if (typeof data.detail === "string") message.detail = data.detail.slice(0, 200);
      return message;
    }
    default:
      return null;
  }
}

const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;
// WHATWG URL parsing accepts hostnames the DNS never would (e.g. a literal "*"), so a wildcard
// origin like "https://*.warsignallabs.net" would otherwise sail through with url.origin intact.
// Require an ordinary dotted hostname (letters/digits/hyphens only) alongside the origin match.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Spec §6.2: exact https origins; a loopback http origin only for the local two-origin e2e. */
export function assertCarryOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    let ok = false;
    try {
      const url = new URL(origin);
      ok = url.origin === origin
        && (LOOPBACK_HTTP.test(origin) || (url.protocol === "https:" && HOSTNAME_RE.test(url.hostname)));
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`[account-kit] carryFrom: "${origin}" is not an exact https origin (or a loopback http origin)`);
  }
}

/** Receiver-side check of an offer against this game's kit config (spec §6.2). */
export function checkOffer(offer: OfferMessage, game: SaveGameConfig): OfferCheck {
  if (offer.gameSlug !== game.gameSlug) return { ok: false, detail: `wrong game "${offer.gameSlug}"` };
  if (offer.schemaVersion !== game.schemaVersion) return { ok: false, detail: `wrong schemaVersion ${offer.schemaVersion}` };
  const slots = Object.keys(offer.slots);
  if (slots.length === 0) return { ok: false, detail: "no slots" };
  for (const slot of slots) {
    if (!game.slots.includes(slot)) return { ok: false, detail: `unknown slot "${slot}"` };
    const payload = offer.slots[slot];
    const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, payload);
    if (!valid.ok) return { ok: false, detail: `${slot}: ${valid.detail}` };
    let bytes: number;
    try {
      bytes = new TextEncoder().encode(canonicalJson(payload)).length;
    } catch (error) {
      return { ok: false, detail: `${slot}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (bytes > MAX_BODY_BYTES) return { ok: false, detail: `${slot}: payload too large` };
  }
  return { ok: true, slots: offer.slots };
}
