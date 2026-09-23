import { CARRY_HASH, OFFER_TIMEOUT_MS, checkOffer, readCarryMessage } from "./protocol.js";
export function receiveCarry(deps, handler) {
    const { win, game } = deps;
    if (win.location.hash !== CARRY_HASH)
        return Promise.resolve("none");
    const href = win.location.href;
    // Keep the page's own history.state (a router's, say); only the URL loses the hash.
    win.history.replaceState(win.history.state, "", href.slice(0, href.length - CARRY_HASH.length));
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
            // Resolve first, then post: a throwing postMessage (a severed or navigated opener) must never
            // leave the receive promise pending, nor escape as an unhandled rejection.
            const settle = (status, detail) => {
                resolve(status);
                try {
                    opener.postMessage({ gw: "carry", v: 1, type: "result", id, status, ...(detail ? { detail } : {}) }, from);
                }
                catch (error) {
                    console.warn(`[account-kit] carry result could not be posted: ${error instanceof Error ? error.message : String(error)}`);
                }
            };
            let handedOff = false;
            try {
                const checked = checkOffer(message, game);
                if (!checked.ok) {
                    console.warn(`[account-kit] carry offer rejected: ${checked.detail}`);
                    settle("rejected", checked.detail);
                    return;
                }
                const slots = JSON.parse(JSON.stringify(checked.slots));
                handedOff = true;
                Promise.resolve()
                    .then(() => handler({ slots, exportedAt: message.exportedAt, from }))
                    .then(
                // Anything but exactly "accepted"/"declined" (e.g. undefined from a JS handler that forgot
                // to return) is "rejected": never an out-of-type result, never a status the sender drops.
                (status) => settle(status === "accepted" || status === "declined" ? status : "rejected"), (error) => {
                    console.warn(`[account-kit] carry handler failed: ${error instanceof Error ? error.message : String(error)}`);
                    settle("rejected", "handler failed");
                });
            }
            catch (error) {
                console.warn(`[account-kit] carry offer failed: ${error instanceof Error ? error.message : String(error)}`);
                settle("rejected", "offer failed");
            }
            finally {
                // Every path above settles; this is the backstop so the promise can never stay pending.
                if (!handedOff)
                    resolve("rejected");
            }
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
