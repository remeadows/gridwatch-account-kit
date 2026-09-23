import { CARRY_HASH, OFFER_TIMEOUT_MS, checkOffer, readCarryMessage } from "./protocol.js";
export function receiveCarry(deps, handler) {
    const { win, game } = deps;
    if (win.location.hash !== CARRY_HASH)
        return Promise.resolve("none");
    const href = win.location.href;
    win.history.replaceState(null, "", href.slice(0, href.length - CARRY_HASH.length));
    const allowed = game.carryFrom ?? [];
    const opener = win.opener;
    if (!opener || allowed.length === 0)
        return Promise.resolve("none");
    const id = (deps.newId ?? (() => crypto.randomUUID()))();
    return new Promise((resolve) => {
        let taken = false;
        let timer;
        const stop = () => { win.removeEventListener("message", onMessage); clearTimeout(timer); };
        function onMessage(event) {
            if (taken || event.source !== opener || !allowed.includes(event.origin))
                return;
            const message = readCarryMessage(event.data);
            if (!message || message.type !== "offer" || message.id !== id)
                return;
            taken = true;
            stop();
            const from = event.origin;
            const reply = (status, detail) => opener.postMessage({ gw: "carry", v: 1, type: "result", id, status, ...(detail ? { detail } : {}) }, from);
            const checked = checkOffer(message, game);
            if (!checked.ok) {
                console.warn(`[account-kit] carry offer rejected: ${checked.detail}`);
                reply("rejected", checked.detail);
                resolve("rejected");
                return;
            }
            const slots = JSON.parse(JSON.stringify(checked.slots));
            Promise.resolve()
                .then(() => handler({ slots, exportedAt: message.exportedAt, from }))
                .then((status) => { reply(status); resolve(status); }, (error) => {
                console.warn(`[account-kit] carry handler failed: ${error instanceof Error ? error.message : String(error)}`);
                reply("rejected", "handler failed");
                resolve("rejected");
            });
        }
        win.addEventListener("message", onMessage);
        timer = setTimeout(() => { if (!taken) {
            stop();
            resolve("none");
        } }, OFFER_TIMEOUT_MS);
        for (const origin of allowed)
            opener.postMessage({ gw: "carry", v: 1, type: "ready", id }, origin);
    });
}
