// Spec §6.2, the kit-facing wrapper: wires the sender and receiver together behind one client and
// the shared replace prompt (spec §6.2's second dialog, alongside the saves conflict/ownership ones).
import { validateReturnPath } from "../returnPath.js";
import { REPLACE_COPY } from "../saves/prompt.js";
import { assertCarryOrigins } from "./protocol.js";
import { receiveCarry } from "./receive.js";
import { sendCarry } from "./send.js";
export { CARRY_HASH } from "./protocol.js";
export function createCarryClient(deps) {
    // Exported, so it checks carryFrom itself: a hand-assembled ["*"] must never get as far as
    // posting the ready nonce to "*".
    if (deps.game.carryFrom)
        assertCarryOrigins(deps.game.carryFrom);
    // Resolved on first send, not at construction: a bad override (e.g. "" from an unset env var,
    // which v0.2.6 tolerated) must not throw from createAccountKit and blank the game. The receiver
    // never needs them, so receive() works whatever nexusOrigin says.
    // Normalised once: a caller-supplied nexusOrigin with a trailing slash (or any other origin
    // spelling `new URL` would still parse) must not make sendCarry's exact `event.origin ===
    // nexusOrigin` check fail every hand-off.
    let target;
    const resolveTarget = () => {
        if (!target) {
            let nexusOrigin;
            try {
                nexusOrigin = new URL(deps.nexusOrigin).origin;
            }
            catch {
                throw new TypeError(`[account-kit] carry: invalid nexusOrigin "${deps.nexusOrigin}"`);
            }
            target = { nexusOrigin, returnPath: validateReturnPath(deps.returnPath, nexusOrigin) };
        }
        return target;
    };
    const win = () => deps.win ?? window;
    let received;
    return {
        send: (slots) => sendCarry({ win: win(), game: deps.game, ...resolveTarget() }, slots),
        receive: (handler) => (received ??= receiveCarry({ win: win(), game: deps.game }, handler)),
        askReplace: async () => {
            try {
                return (await deps.prompt.ask(REPLACE_COPY)) === "primary";
            }
            catch {
                return false; // the shared prompt host was disposed (or failed): nothing is replaced
            }
        },
    };
}
