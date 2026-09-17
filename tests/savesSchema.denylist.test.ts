import { describe, expect, it } from "vitest";
import { DENYLIST, findDeniedKey, normalizeKey } from "../src/saves-schema/denylist";

describe("denylist", () => {
  it("is the spec list", () => {
    expect([...DENYLIST]).toEqual(["token", "refresh", "secret", "apikey", "analytics", "session", "jwt", "proof", "password", "credential"]);
  });
  it("normalizes keys by lower-casing and stripping non-alphanumerics", () => {
    expect(normalizeKey("Access_Token-2")).toBe("accesstoken2");
    expect(normalizeKey("API key")).toBe("apikey");
  });
  it("rejects camel-case, snake-case, case-variant and nested hits with a path", () => {
    expect(findDeniedKey({ accessToken: "x" })).toBe("$.accessToken");
    expect(findDeniedKey({ profile: { refresh_token: "x" } })).toBe("$.profile.refresh_token");
    expect(findDeniedKey({ AnalyticsId: 1 })).toBe("$.AnalyticsId");
    expect(findDeniedKey({ rankingSecret: 1 })).toBe("$.rankingSecret");
    expect(findDeniedKey({ items: [{ ok: 1 }, { "api-key": 1 }] })).toBe("$.items[1].api-key");
    expect(findDeniedKey({ nested: { deep: { JWT: "" } } })).toBe("$.nested.deep.JWT");
  });
  it("accepts ordinary game keys and looks only at keys, not values", () => {
    expect(findDeniedKey({ coins: 3, levels: { "1": { stars: 3, score: 10 } }, note: "my secret token" })).toBeNull();
    expect(findDeniedKey([1, "token", null])).toBeNull();
  });
});
