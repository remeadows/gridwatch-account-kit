import type { SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";
import { type CarryStatus } from "./protocol.js";
export type ReceiveResult = "none" | CarryStatus;
export interface CarryOffer {
    slots: Record<string, SavePayload>;
    exportedAt: string;
    from: string;
}
/** Applies (or declines) a validated offer. It must always settle with "accepted" or "declined":
 *  any other answer is treated as "rejected", a throw or rejection as "rejected" ("handler
 *  failed"), and a handler that never settles leaves receive() pending and the sender waiting. */
export type CarryHandler = (offer: CarryOffer) => Promise<"accepted" | "declined">;
export interface OpenerWindow {
    postMessage(message: unknown, targetOrigin: string): void;
}
export interface ReceiverWindow {
    readonly location: {
        readonly hash: string;
        readonly href: string;
    };
    readonly opener: OpenerWindow | null;
    readonly history: {
        readonly state: unknown;
        replaceState(data: unknown, unused: string, url?: string): void;
    };
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
export interface ReceiverDeps {
    win: ReceiverWindow;
    game: SaveGameConfig;
    newId?: () => string;
}
export declare function receiveCarry(deps: ReceiverDeps, handler: CarryHandler): Promise<ReceiveResult>;
