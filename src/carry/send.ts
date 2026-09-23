// Spec §6.2, old-origin side. `window.open` happens synchronously inside the caller's click
// handler, before any await, or popup blockers refuse the tab.
import { validatePayload } from "../saves-schema/games.js";
import type { SavePayload } from "../saves-schema/wire.js";
import type { SaveGameConfig } from "../saves/types.js";
import { CARRY_HASH, CLOSED_POLL_MS, READY_TIMEOUT_MS, readCarryMessage } from "./protocol.js";

export type SendResult = "accepted" | "declined" | "rejected" | "blocked" | "closed" | "timeout";
export interface OpenedWindow { readonly closed: boolean; postMessage(message: unknown, targetOrigin: string): void }
export interface SenderWindow {
  readonly location: { readonly origin: string };
  open(url: string, target: string): OpenedWindow | null;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
export interface SenderDeps { win: SenderWindow; game: SaveGameConfig; nexusOrigin: string; returnPath: string; now?: () => Date }

export function sendCarry(deps: SenderDeps, slots: Record<string, SavePayload>): Promise<SendResult> {
  const { win, game, nexusOrigin } = deps;
  if (win.location.origin === nexusOrigin) throw new Error("[account-kit] carry.send is for old hostnames; this is the Nexus origin");
  const names = Object.keys(slots);
  if (names.length === 0) throw new RangeError("[account-kit] carry.send: no slots to send");
  for (const slot of names) {
    if (!game.slots.includes(slot)) throw new RangeError(`[account-kit] carry.send: unknown slot "${slot}"`);
    const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, slots[slot]);
    if (!valid.ok) throw new TypeError(`[account-kit] carry.send: ${slot}: ${valid.detail}`);
  }
  const copy = JSON.parse(JSON.stringify(slots)) as Record<string, SavePayload>;
  const opened = win.open(`${nexusOrigin.replace(/\/+$/, "")}${deps.returnPath}${CARRY_HASH}`, "_blank");
  if (!opened) return Promise.resolve("blocked");

  return new Promise<SendResult>((resolve) => {
    let id: string | null = null;
    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let closedPoll: ReturnType<typeof setInterval> | undefined;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      win.removeEventListener("message", onMessage);
      clearTimeout(readyTimer);
      clearInterval(closedPoll);
      resolve(result);
    };
    function onMessage(event: MessageEvent): void {
      if (event.origin !== nexusOrigin || event.source !== opened) return;
      const message = readCarryMessage(event.data);
      if (!message) return;
      if (message.type === "ready" && id === null) {
        id = message.id;
        opened!.postMessage({
          gw: "carry", v: 1, type: "offer", id, gameSlug: game.gameSlug, schemaVersion: game.schemaVersion,
          slots: copy, exportedAt: (deps.now?.() ?? new Date()).toISOString(),
        }, nexusOrigin);
        // Only once the offer is really out: a throwing post leaves the ready timer running, so the
        // hand-off still ends in "timeout" instead of waiting on a result that can never come.
        clearTimeout(readyTimer);
      } else if (message.type === "result" && id !== null && message.id === id) {
        finish(message.status);
      }
    }
    win.addEventListener("message", onMessage);
    readyTimer = setTimeout(() => finish("timeout"), READY_TIMEOUT_MS);
    closedPoll = setInterval(() => { if (opened.closed) finish("closed"); }, CLOSED_POLL_MS);
  });
}
