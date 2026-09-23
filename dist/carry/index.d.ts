import type { SavePayload } from "../saves-schema/wire.js";
import { type PromptHost } from "../saves/prompt.js";
import type { SaveGameConfig } from "../saves/types.js";
import { type CarryHandler, type ReceiveResult, type ReceiverWindow } from "./receive.js";
import { type SendResult, type SenderWindow } from "./send.js";
export { CARRY_HASH } from "./protocol.js";
export type { SendResult } from "./send.js";
export type { ReceiveResult, CarryOffer, CarryHandler } from "./receive.js";
export interface CarryClient {
    /** Old hostname only. Call it synchronously from the click handler. */
    send(slots: Record<string, SavePayload>): Promise<SendResult>;
    /** Nexus only. Resolves "none" at once unless this tab was opened by a hand-off. Call it once,
     *  before the first reconcile; later calls return the first call's promise and ignore their
     *  handler (so a React StrictMode or HMR double-mount never starts a second receiver). */
    receive(handler: CarryHandler): Promise<ReceiveResult>;
    /** The replace prompt (spec §6.2): true = "Replace". False ("Keep this site's") also when the
     *  shared prompt host is disposed (e.g. by kit.saves.dispose()) while the prompt is open. */
    askReplace(): Promise<boolean>;
}
export interface CarryClientDeps {
    game: SaveGameConfig;
    nexusOrigin: string;
    returnPath: string;
    prompt: PromptHost;
    win?: SenderWindow & ReceiverWindow;
}
export declare function createCarryClient(deps: CarryClientDeps): CarryClient;
