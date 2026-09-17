// Canonical JSON (RFC 8785 shape: recursively sorted keys, no whitespace, JSON.stringify
// escaping and number forms) and the server-side request hash from spec §3.1.
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
        default:
            if (typeof value === "object")
                return;
            throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
    }
}
function serialize(value, path) {
    assertJsonValue(value, path);
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
    const record = value;
    const keys = Object.keys(record).sort(); // default sort = UTF-16 code unit order (RFC 8785)
    const parts = [];
    for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
}
export function canonicalJson(value) {
    return serialize(value, "$");
}
export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** SHA-256 over the canonical JSON of exactly { game, slot, schemaVersion, baseRevision, payload }. */
export async function requestHash(input) {
    const { game, slot, schemaVersion, baseRevision, payload } = input;
    return sha256Hex(canonicalJson({ game, slot, schemaVersion, baseRevision, payload }));
}
