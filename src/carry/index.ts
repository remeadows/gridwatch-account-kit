// Spec §6.2, the kit-facing wrapper: wires the sender and receiver together behind one client and
// the shared replace prompt (spec §6.2's second dialog, alongside the saves conflict/ownership ones).
import { validateReturnPath } from "../returnPath.js";
import type { SavePayload } from "../saves-schema/wire.js";
import { REPLACE_COPY, type PromptHost } from "../saves/prompt.js";
import type { SaveGameConfig } from "../saves/types.js";
import { assertCarryOrigins } from "./protocol.js";
import { receiveCarry, type CarryHandler, type ReceiveResult, type ReceiverWindow } from "./receive.js";
import { sendCarry, type SendResult, type SenderWindow } from "./send.js";

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
  game: SaveGameConfig; nexusOrigin: string; returnPath: string; prompt: PromptHost;
  win?: SenderWindow & ReceiverWindow;
}

export function createCarryClient(deps: CarryClientDeps): CarryClient {
  // Exported, so it checks carryFrom itself: a hand-assembled ["*"] must never get as far as
  // posting the ready nonce to "*".
  if (deps.game.carryFrom) assertCarryOrigins(deps.game.carryFrom);
  // Resolved on first send, not at construction: a bad override (e.g. "" from an unset env var,
  // which v0.2.6 tolerated) must not throw from createAccountKit and blank the game. The receiver
  // never needs them, so receive() works whatever nexusOrigin says.
  // Normalised once: a caller-supplied nexusOrigin with a trailing slash (or any other origin
  // spelling `new URL` would still parse) must not make sendCarry's exact `event.origin ===
  // nexusOrigin` check fail every hand-off.
  let target: { nexusOrigin: string; returnPath: string } | undefined;
  const resolveTarget = () => {
    if (!target) {
      // Only a web origin: `javascript:`, `data:`, `file:`, `mailto:` … parse fine but give an
      // opaque ("null") or non-http origin that send would open and pin event.origin against.
      let url: URL | undefined;
      try { url = new URL(deps.nexusOrigin); } catch { url = undefined; }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
        throw new TypeError(`[account-kit] carry: invalid nexusOrigin "${deps.nexusOrigin}"`);
      }
      const nexusOrigin = url.origin;
      target = { nexusOrigin, returnPath: validateReturnPath(deps.returnPath, nexusOrigin) };
    }
    return target;
  };
  const win = () => deps.win ?? (window as unknown as SenderWindow & ReceiverWindow);
  let received: Promise<ReceiveResult> | undefined;
  return {
    send: (slots) => sendCarry({ win: win(), game: deps.game, ...resolveTarget() }, slots),
    receive: (handler) => (received ??= receiveCarry({ win: win(), game: deps.game }, handler)),
    askReplace: async () => {
      try {
        return (await deps.prompt.ask(REPLACE_COPY)) === "primary";
      } catch {
        return false; // the shared prompt host was disposed (or failed): nothing is replaced
      }
    },
  };
}
