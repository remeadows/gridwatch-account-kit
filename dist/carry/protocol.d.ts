import { type SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";
export declare const CARRY_HASH = "#gw-carry";
export declare const READY_TIMEOUT_MS = 20000;
export declare const OFFER_TIMEOUT_MS = 20000;
export declare const CLOSED_POLL_MS = 1000;
export type CarryStatus = "accepted" | "declined" | "rejected";
interface Envelope {
    gw: "carry";
    v: 1;
    id: string;
}
export interface ReadyMessage extends Envelope {
    type: "ready";
}
export interface OfferMessage extends Envelope {
    type: "offer";
    gameSlug: string;
    schemaVersion: number;
    slots: Record<string, SavePayload>;
    exportedAt: string;
}
export interface ResultMessage extends Envelope {
    type: "result";
    status: CarryStatus;
    detail?: string;
}
export type CarryMessage = ReadyMessage | OfferMessage | ResultMessage;
export type OfferCheck = {
    ok: true;
    slots: Record<string, SavePayload>;
} | {
    ok: false;
    detail: string;
};
/** Structural read of an incoming message. Anything that is not exactly one of the three shapes is null. */
export declare function readCarryMessage(data: unknown): CarryMessage | null;
/** Spec §6.2: exact https origins; a loopback http origin only for the local two-origin e2e. */
export declare function assertCarryOrigins(origins: readonly string[]): void;
/** Receiver-side check of an offer against this game's kit config (spec §6.2). */
export declare function checkOffer(offer: OfferMessage, game: SaveGameConfig): OfferCheck;
export {};
