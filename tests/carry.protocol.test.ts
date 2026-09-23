import { describe, expect, it } from "vitest";
import { assertCarryOrigins, checkOffer, readCarryMessage, type OfferMessage } from "../src/carry/protocol";

const GAME = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 } as const;
const SETTINGS = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };
const offer = (over: Partial<OfferMessage> = {}): OfferMessage => ({
  gw: "carry", v: 1, type: "offer", id: "n1", gameSlug: "gridwatch-match", schemaVersion: 1,
  slots: { settings: SETTINGS }, exportedAt: "2026-09-22T00:00:00.000Z", ...over,
});

describe("readCarryMessage", () => {
  it("accepts the three message shapes", () => {
    expect(readCarryMessage({ gw: "carry", v: 1, type: "ready", id: "n1" })).toEqual({ gw: "carry", v: 1, type: "ready", id: "n1" });
    expect(readCarryMessage(offer())).toEqual(offer());
    expect(readCarryMessage({ gw: "carry", v: 1, type: "result", id: "n1", status: "declined" })).toEqual({ gw: "carry", v: 1, type: "result", id: "n1", status: "declined" });
  });
  it("rejects foreign, versioned-away and malformed messages", () => {
    for (const bad of [null, "x", [], { gw: "other", v: 1, type: "ready", id: "n1" }, { gw: "carry", v: 2, type: "ready", id: "n1" },
      { gw: "carry", v: 1, type: "ready", id: "" }, { gw: "carry", v: 1, type: "ready", id: "x".repeat(65) },
      { gw: "carry", v: 1, type: "result", id: "n1", status: "maybe" }, { gw: "carry", v: 1, type: "offer", id: "n1", slots: {} }, { gw: "carry", v: 1, type: "nope", id: "n1" }]) {
      expect(readCarryMessage(bad)).toBeNull();
    }
  });
  it("truncates a result detail to 200 characters", () => {
    const msg = readCarryMessage({ gw: "carry", v: 1, type: "result", id: "n1", status: "rejected", detail: "d".repeat(500) });
    expect(msg && msg.type === "result" && msg.detail?.length).toBe(200);
  });
});

describe("assertCarryOrigins", () => {
  it("accepts exact https origins and loopback http origins", () => {
    expect(() => assertCarryOrigins(["https://gridwatchmatchweb.warsignallabs.net", "http://localhost:4173", "http://127.0.0.1:4173"])).not.toThrow();
  });
  it.each([
    "http://gridwatchmatchweb.warsignallabs.net", "https://gridwatchmatchweb.warsignallabs.net/", "https://gridwatchmatchweb.warsignallabs.net/play/match/",
    "https://*.warsignallabs.net", "*", "", "localhost:4173", "http://localhost", "http://192.168.1.5:4173", "ftp://example.com",
  ])("rejects %s", (origin) => {
    expect(() => assertCarryOrigins([origin])).toThrow(/carryFrom/);
  });
});

describe("checkOffer", () => {
  it("passes a valid offer through", () => {
    expect(checkOffer(offer(), GAME)).toEqual({ ok: true, slots: { settings: SETTINGS } });
  });
  it.each([
    ["wrong game", offer({ gameSlug: "grid-drift" }), /game/],
    ["wrong schema", offer({ schemaVersion: 2 }), /schemaVersion/],
    ["no slots", offer({ slots: {} }), /no slots/],
    ["unknown slot", offer({ slots: { secrets: {} } as never }), /unknown slot/],
    ["invalid payload", offer({ slots: { settings: { musicEnabled: "yes" } } as never }), /settings/],
    ["denylisted key", offer({ slots: { settings: { ...SETTINGS, accessToken: "x" } } as never }), /settings/],
  ])("rejects %s", (_name, bad, detail) => {
    const result = checkOffer(bad, GAME);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toMatch(detail);
  });
});
