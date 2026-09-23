import type { SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";
export type SendResult = "accepted" | "declined" | "rejected" | "blocked" | "closed" | "timeout";
export interface OpenedWindow {
    readonly closed: boolean;
    postMessage(message: unknown, targetOrigin: string): void;
}
export interface SenderWindow {
    readonly location: {
        readonly origin: string;
    };
    open(url: string, target: string): OpenedWindow | null;
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
export interface SenderDeps {
    win: SenderWindow;
    game: SaveGameConfig;
    nexusOrigin: string;
    returnPath: string;
    now?: () => Date;
}
export declare function sendCarry(deps: SenderDeps, slots: Record<string, SavePayload>): Promise<SendResult>;
