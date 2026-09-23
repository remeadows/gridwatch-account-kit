// Spec §6.2, the kit-facing wrapper: wires the sender and receiver together behind one client and
// the shared replace prompt (spec §6.2's second dialog, alongside the saves conflict/ownership ones).
import { validateReturnPath } from "../returnPath.js";
import { REPLACE_COPY } from "../saves/prompt.js";
import { receiveCarry } from "./receive.js";
import { sendCarry } from "./send.js";
export { CARRY_HASH } from "./protocol.js";
export function createCarryClient(deps) {
    // Normalised once: a caller-supplied nexusOrigin with a trailing slash (or any other origin
    // spelling `new URL` would still parse) must not make sendCarry's exact `event.origin ===
    // nexusOrigin` check fail every hand-off. Same input to both send and receive.
    const nexusOrigin = new URL(deps.nexusOrigin).origin;
    const returnPath = validateReturnPath(deps.returnPath, nexusOrigin);
    const win = () => deps.win ?? window;
    return {
        send: (slots) => sendCarry({ win: win(), game: deps.game, nexusOrigin, returnPath }, slots),
        receive: (handler) => receiveCarry({ win: win(), game: deps.game }, handler),
        askReplace: async () => (await deps.prompt.ask(REPLACE_COPY)) === "primary",
    };
}
