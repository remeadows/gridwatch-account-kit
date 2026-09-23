// Spec §6.2, old-origin side. `window.open` happens synchronously inside the caller's click
// handler, before any await, or popup blockers refuse the tab.
import { validatePayload } from "../saves-schema/games.js";
import { CARRY_HASH, CLOSED_POLL_MS, READY_TIMEOUT_MS, readCarryMessage } from "./protocol.js";
export function sendCarry(deps, slots) {
    const { win, game, nexusOrigin } = deps;
    if (win.location.origin === nexusOrigin)
        throw new Error("[account-kit] carry.send is for old hostnames; this is the Nexus origin");
    const names = Object.keys(slots);
    if (names.length === 0)
        throw new RangeError("[account-kit] carry.send: no slots to send");
    for (const slot of names) {
        if (!game.slots.includes(slot))
            throw new RangeError(`[account-kit] carry.send: unknown slot "${slot}"`);
        const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, slots[slot]);
        if (!valid.ok)
            throw new TypeError(`[account-kit] carry.send: ${slot}: ${valid.detail}`);
    }
    const copy = JSON.parse(JSON.stringify(slots));
    const opened = win.open(`${nexusOrigin.replace(/\/+$/, "")}${deps.returnPath}${CARRY_HASH}`, "_blank");
    if (!opened)
        return Promise.resolve("blocked");
    return new Promise((resolve) => {
        let id = null;
        let settled = false;
        let readyTimer;
        let closedPoll;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            win.removeEventListener("message", onMessage);
            clearTimeout(readyTimer);
            clearInterval(closedPoll);
            resolve(result);
        };
        function onMessage(event) {
            if (event.origin !== nexusOrigin || event.source !== opened)
                return;
            const message = readCarryMessage(event.data);
            if (!message)
                return;
            if (message.type === "ready" && id === null) {
                id = message.id;
                clearTimeout(readyTimer);
                opened.postMessage({
                    gw: "carry", v: 1, type: "offer", id, gameSlug: game.gameSlug, schemaVersion: game.schemaVersion,
                    slots: copy, exportedAt: (deps.now?.() ?? new Date()).toISOString(),
                }, nexusOrigin);
            }
            else if (message.type === "result" && id !== null && message.id === id) {
                finish(message.status);
            }
        }
        win.addEventListener("message", onMessage);
        readyTimer = setTimeout(() => finish("timeout"), READY_TIMEOUT_MS);
        closedPoll = setInterval(() => { if (opened.closed)
            finish("closed"); }, CLOSED_POLL_MS);
    });
}
