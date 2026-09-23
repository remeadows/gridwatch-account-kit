// Spec §6.2, the kit-facing wrapper: wires the sender and receiver together behind one client and
// the shared replace prompt (spec §6.2's second dialog, alongside the saves conflict/ownership ones).
import { validateReturnPath } from "../returnPath.js";
import type { SavePayload } from "../saves-schema/wire.js";
import { REPLACE_COPY, type PromptHost } from "../saves/prompt.js";
import type { SaveGameConfig } from "../saves/types.js";
import { receiveCarry, type CarryHandler, type ReceiveResult, type ReceiverWindow } from "./receive.js";
import { sendCarry, type SendResult, type SenderWindow } from "./send.js";

export { CARRY_HASH } from "./protocol.js";
export type { SendResult } from "./send.js";
export type { ReceiveResult, CarryOffer, CarryHandler } from "./receive.js";

export interface CarryClient {
  /** Old hostname only. Call it synchronously from the click handler. */
  send(slots: Record<string, SavePayload>): Promise<SendResult>;
  /** Nexus only. Resolves "none" at once unless this tab was opened by a hand-off. */
  receive(handler: CarryHandler): Promise<ReceiveResult>;
  /** The replace prompt (spec §6.2): true = "Replace". */
  askReplace(): Promise<boolean>;
}

export interface CarryClientDeps {
  game: SaveGameConfig; nexusOrigin: string; returnPath: string; prompt: PromptHost;
  win?: SenderWindow & ReceiverWindow;
}

export function createCarryClient(deps: CarryClientDeps): CarryClient {
  // Normalised once: a caller-supplied nexusOrigin with a trailing slash (or any other origin
  // spelling `new URL` would still parse) must not make sendCarry's exact `event.origin ===
  // nexusOrigin` check fail every hand-off. Same input to both send and receive.
  const nexusOrigin = new URL(deps.nexusOrigin).origin;
  const returnPath = validateReturnPath(deps.returnPath, nexusOrigin);
  const win = () => deps.win ?? (window as unknown as SenderWindow & ReceiverWindow);
  return {
    send: (slots) => sendCarry({ win: win(), game: deps.game, nexusOrigin, returnPath }, slots),
    receive: (handler) => receiveCarry({ win: win(), game: deps.game }, handler),
    askReplace: async () => (await deps.prompt.ask(REPLACE_COPY)) === "primary",
  };
}
