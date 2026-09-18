// v4 UUID generation shared by the device id (state.ts) and the per-flush idempotency key
// (client.ts). Prefers the platform generator; falls back to a getRandomValues-based v4 when
// it's absent (older browsers, some SSR/test runtimes) instead of failing outright.
export function uuidV4() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        return crypto.randomUUID();
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
        throw new Error("[account-kit] crypto.getRandomValues is required for cloud saves");
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    const groups = [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10, 16)];
    return groups.map((g) => g.join("")).join("-");
}
