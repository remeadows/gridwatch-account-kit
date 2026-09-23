// Spec §6.2, Nexus side. Plan ruling: no valid offer within OFFER_TIMEOUT_MS → "none", because the
// game holds its cloud start until this settles.
import type { SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";
import { CARRY_HASH, OFFER_TIMEOUT_MS, checkOffer, readCarryMessage, type CarryStatus } from "./protocol.js";

export type ReceiveResult = "none" | CarryStatus;
export interface CarryOffer { slots: Record<string, SavePayload>; exportedAt: string; from: string }
export type CarryHandler = (offer: CarryOffer) => Promise<"accepted" | "declined">;
export interface OpenerWindow { postMessage(message: unknown, targetOrigin: string): void }
export interface ReceiverWindow {
  readonly location: { readonly hash: string; readonly href: string };
  readonly opener: OpenerWindow | null;
  readonly history: { replaceState(data: unknown, unused: string, url?: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
export interface ReceiverDeps { win: ReceiverWindow; game: SaveGameConfig; newId?: () => string }

export function receiveCarry(deps: ReceiverDeps, handler: CarryHandler): Promise<ReceiveResult> {
  const { win, game } = deps;
  if (win.location.hash !== CARRY_HASH) return Promise.resolve("none");
  const href = win.location.href;
  win.history.replaceState(null, "", href.slice(0, href.length - CARRY_HASH.length));
  const allowed = game.carryFrom ?? [];
  const opener = win.opener;
  if (!opener || allowed.length === 0) return Promise.resolve("none");
  const id = (deps.newId ?? (() => crypto.randomUUID()))();

  return new Promise<ReceiveResult>((resolve) => {
    let taken = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { win.removeEventListener("message", onMessage); clearTimeout(timer); };
    function onMessage(event: MessageEvent): void {
      if (taken || event.source !== opener || !allowed.includes(event.origin)) return;
      const message = readCarryMessage(event.data);
      if (!message || message.type !== "offer" || message.id !== id) return;
      taken = true;
      stop();
      const from = event.origin;
      const reply = (status: CarryStatus, detail?: string) =>
        opener!.postMessage({ gw: "carry", v: 1, type: "result", id, status, ...(detail ? { detail } : {}) }, from);
      const checked = checkOffer(message, game);
      if (!checked.ok) {
        console.warn(`[account-kit] carry offer rejected: ${checked.detail}`);
        reply("rejected", checked.detail);
        resolve("rejected");
        return;
      }
      const slots = JSON.parse(JSON.stringify(checked.slots)) as Record<string, SavePayload>;
      Promise.resolve()
        .then(() => handler({ slots, exportedAt: message.exportedAt, from }))
        .then(
          (status) => { reply(status); resolve(status); },
          (error: unknown) => {
            console.warn(`[account-kit] carry handler failed: ${error instanceof Error ? error.message : String(error)}`);
            reply("rejected", "handler failed");
            resolve("rejected");
          },
        );
    }
    win.addEventListener("message", onMessage);
    timer = setTimeout(() => { if (!taken) { stop(); resolve("none"); } }, OFFER_TIMEOUT_MS);
    for (const origin of allowed) opener.postMessage({ gw: "carry", v: 1, type: "ready", id }, origin);
  });
}
