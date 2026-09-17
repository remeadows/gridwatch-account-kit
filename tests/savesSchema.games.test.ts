import { describe, expect, it } from "vitest";
import { MATCH_CAMPAIGN_V1, MATCH_SETTINGS_V1, SAVE_GAMES, payloadSchemas, resolveSaveGame, validatePayload } from "../src/saves-schema/games";
import { ALIAS_RE, MAX_BODY_BYTES, SLOT_RE, UUID_RE } from "../src/saves-schema/wire";

const campaign = {
  coins: 120,
  boosters: { rocket: 3, rocketVertical: 2, tnt: 3, propeller: 1, lightBall: 0 },
  selectedHeroId: "rusty",
  completedTutorial: true,
  tutorialReplayRequested: false,
  levels: { "1": { stars: 3, score: 1200, completedAt: "2026-09-17T10:00:00.000Z" } },
  areaRewards: { "area-1": true },
  intelSeen: { "intel-01": true },
};
const settings = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };

describe("save game registry", () => {
  it("registers only Match in 4a", () => {
    expect(SAVE_GAMES).toEqual({ match: { slug: "gridwatch-match", slots: ["campaign", "settings"], schemaVersion: 1 } });
    expect(resolveSaveGame("match")).toEqual(SAVE_GAMES.match);
    for (const alias of ["zero", "breach", "drift", "gambit", "MATCH", "match/"]) expect(resolveSaveGame(alias)).toBeNull();
    expect(payloadSchemas["gridwatch-match"][1]).toEqual({ campaign: MATCH_CAMPAIGN_V1, settings: MATCH_SETTINGS_V1 });
  });
  it("validates the Match v1 slots", () => {
    expect(validatePayload("gridwatch-match", 1, "campaign", campaign)).toEqual({ ok: true });
    expect(validatePayload("gridwatch-match", 1, "settings", settings)).toEqual({ ok: true });
    expect(validatePayload("gridwatch-match", 1, "campaign", { ...campaign, version: 1 })).toEqual({ ok: false, detail: "$.version: unknown property" });
    expect(validatePayload("gridwatch-match", 1, "campaign", { ...campaign, levels: { "1": { stars: 4, score: 1, completedAt: "x" } } })).toEqual({ ok: false, detail: "$.levels.1.stars: above maximum 3" });
    expect(validatePayload("gridwatch-match", 1, "settings", { ...settings, extra: true })).toEqual({ ok: false, detail: "$.extra: unknown property" });
  });
  it("rejects unknown game, version, or slot and denylisted keys", () => {
    expect(validatePayload("gridwatch-zero", 1, "campaign", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
    expect(validatePayload("gridwatch-match", 2, "campaign", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
    expect(validatePayload("gridwatch-match", 1, "inventory", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
    expect(validatePayload("gridwatch-match", 1, "campaign", { ...campaign, intelSeen: { accessToken: true } })).toEqual({ ok: false, detail: "denied_key $.intelSeen.accessToken" });
  });
  it("does not resolve a schema by walking the prototype chain (__proto__/constructor lookups)", () => {
    expect(validatePayload("gridwatch-match", 1, "__proto__", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
    expect(validatePayload("constructor", "prototype" as never, "constructor", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
  });
  it("rejects a non-integer schemaVersion (e.g. a string) instead of coercing it", () => {
    expect(validatePayload("gridwatch-match", "1" as never, "campaign", campaign)).toEqual({ ok: false, detail: "unknown_schema" });
  });
  it("publishes the wire constants", () => {
    expect(MAX_BODY_BYTES).toBe(65536);
    expect(UUID_RE.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
    expect(SLOT_RE.test("campaign")).toBe(true);
    expect(SLOT_RE.test("Campaign")).toBe(false);
    expect(SLOT_RE.test("a".repeat(33))).toBe(false);
    expect(ALIAS_RE.test("match")).toBe(true);
    expect(ALIAS_RE.test("match-2")).toBe(false);
  });
});
