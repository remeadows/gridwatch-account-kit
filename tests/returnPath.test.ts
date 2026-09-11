import { describe, expect, it } from "vitest";
import { signInUrl, validateReturnPath } from "../src/returnPath";

const N = "https://nexus.warsignallabs.net";

describe("validateReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/play/match/", "/play/match/"],
    ["/play/match/level/3?x=1", "/play/match/level/3?x=1"],
    ["/oauth/consent?authorization_id=abc-123_XYZ", "/oauth/consent?authorization_id=abc-123_XYZ"],
  ])("accepts %s", (raw, expected) => expect(validateReturnPath(raw, N)).toBe(expected));

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/play/match/../../auth/signout",
    "/play/match/foo/../bar",     // normalizes to a valid nested path — still rejected (raw dot segment)
    "/play/match/./level",
    "/play/match/%2E%2E/",
    "/play/match/%2e%2e/",
    "/play/match\\evil",
    "/play/match/%5Cevil",
    "/play/unknown/",
    "/play/match",            // not under the base (no trailing slash)
    "/auth/signout",
    "/oauth/consent",         // no authorization_id
    "/oauth/consent?authorization_id=a&x=1",
    "",
    null,
    undefined,
  ])("rejects %s → /", (raw) => expect(validateReturnPath(raw as string, N)).toBe("/"));
});

describe("signInUrl", () => {
  it("builds the Nexus sign-in URL with an encoded, validated return", () => {
    expect(signInUrl("/play/match/", N)).toBe("https://nexus.warsignallabs.net/account/sign-in?return=%2Fplay%2Fmatch%2F");
    expect(signInUrl("//evil.example/", N)).toBe("https://nexus.warsignallabs.net/account/sign-in?return=%2F");
  });
});
