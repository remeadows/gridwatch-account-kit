// Canonical JSON (RFC 8785 shape: recursively sorted keys, no whitespace, JSON.stringify
// escaping and number forms) and the server-side request hash from spec §3.1.
import { LIMITS } from "./validate.js";
// RFC 8785 rejects a string containing an unpaired UTF-16 surrogate; JSON.stringify silently
// escapes it instead of rejecting it, so this must be checked explicitly for every string that
// goes through canonicalJson, values and object keys alike.
//
// This is a manual code-unit scan rather than a regex lookbehind assertion: lookbehind is a
// PARSE-time feature, so having one anywhere in this module would fail to even load on an
// engine that lacks it (Safari < 16.4), taking the whole saves-schema module down with it.
export function hasLoneSurrogate(text) {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            // High surrogate: must be immediately followed by a low surrogate.
            const next = text.charCodeAt(i + 1);
            if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)
                return true;
            i++; // consume the valid pair
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            // A low surrogate reached without having consumed a preceding high surrogate is lone.
            return true;
        }
    }
    return false;
}
function assertWellFormedString(value, path) {
    if (hasLoneSurrogate(value))
        throw new TypeError(`canonicalJson: lone surrogate at ${path}`);
}
function assertJsonValue(value, path) {
    if (value === null)
        return;
    switch (typeof value) {
        case "string":
        case "boolean":
            return;
        case "number":
            if (!Number.isFinite(value))
                throw new TypeError(`canonicalJson: non-finite number at ${path}`);
            return;
        case "object": {
            if (Array.isArray(value))
                return;
            const proto = Object.getPrototypeOf(value);
            if (proto === Object.prototype || proto === null)
                return;
            throw new TypeError(`canonicalJson: unsupported object at ${path}`);
        }
        default:
            throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
    }
}
function serialize(value, path, depth) {
    if (depth > LIMITS.maxDepth)
        throw new RangeError(`canonicalJson: deeper than ${LIMITS.maxDepth}`);
    assertJsonValue(value, path);
    if (typeof value === "string") {
        assertWellFormedString(value, path);
        return JSON.stringify(value);
    }
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        // Array.prototype.map skips holes (Array(2) -> [<2 empty>]), which would silently drop data
        // instead of rejecting it. Walk every index explicitly and reject anything not an own property.
        const parts = [];
        for (let i = 0; i < value.length; i++) {
            if (!Object.hasOwn(value, i))
                throw new TypeError(`canonicalJson: sparse array at ${path}[${i}]`);
            parts.push(serialize(value[i], `${path}[${i}]`, depth + 1));
        }
        return `[${parts.join(",")}]`;
    }
    const record = value;
    const keys = Object.keys(record).sort(); // default sort = UTF-16 code unit order (RFC 8785)
    const parts = [];
    for (const key of keys) {
        assertWellFormedString(key, `${path}.${key}`);
        parts.push(`${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
}
export function canonicalJson(value) {
    return serialize(value, "$", 0);
}
export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** SHA-256 over the canonical JSON of exactly { game, slot, schemaVersion, baseRevision, payload }.
 *
 *  The wrapper is serialized at depth -1, so the payload itself sits at depth 0 — exactly where
 *  validatePayload measures it from. Any payload the validator accepts (up to LIMITS.maxDepth) can
 *  therefore be hashed, and one level deeper is still refused, with the same "deeper than" limit. */
export async function requestHash(input) {
    const { game, slot, schemaVersion, baseRevision, payload } = input;
    return sha256Hex(serialize({ game, slot, schemaVersion, baseRevision, payload }, "$", -1));
}
