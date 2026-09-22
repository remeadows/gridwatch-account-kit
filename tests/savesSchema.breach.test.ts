import { describe, expect, it } from "vitest";
import { resolveSaveGame, validatePayload } from "../src/saves-schema/games";
import { MAX_BODY_BYTES } from "../src/saves-schema/wire";

const empty = { contentRevision: "expansion-1-r4", clearedLevels: [], settings: { lowEffects: false } };
const checkpoint = { completedWaves: 4, tick: 12000, level: 25, contentHash: "a".repeat(64), seed: "test", commands: [0, 12287551] };
const validate = (value: unknown) => validatePayload("gridwatch-signal-breach", 1, "expansion-1-r4", value);

describe("Breach expansion save registry", () => {
  it("registers only the isolated r4 slot, not original campaign or historical revisions", () => {
    expect(resolveSaveGame("breach")).toEqual({ slug: "gridwatch-signal-breach", slots: ["expansion-1-r4"], schemaVersion: 1 });
    for (const slot of ["campaign", "settings", "expansion-1-r1", "expansion-1-r3"]) {
      expect(validatePayload("gridwatch-signal-breach", 1, slot, empty)).toEqual({ ok: false, detail: "unknown_schema" });
    }
    expect(validatePayload("gridwatch-signal-breach", 2, "expansion-1-r4", empty).ok).toBe(false);
    expect(validatePayload("gridwatch-match", 1, "expansion-1-r4", empty).ok).toBe(false);
  });
  it("accepts progress/settings with an optional compact checkpoint", () => {
    expect(validate(empty)).toEqual({ ok: true });
    expect(validate({ ...empty, clearedLevels: [1, 25], checkpoint })).toEqual({ ok: true });
  });
  it("rejects unknown fields, invalid identities, limits, and state/auth blobs", () => {
    for (const value of [
      { ...empty, contentRevision: "expansion-1-r3" },
      { ...empty, clearedLevels: [0] }, { ...empty, clearedLevels: [26] },
      { ...empty, clearedLevels: Array(26).fill(1) },
      { ...empty, checkpoint: null }, { ...empty, score: 123 },
      { ...empty, accessToken: "never-store-credentials" },
      { ...empty, settings: { lowEffects: 1 } },
      ...[{ level: 26 }, { tick: 12001 }, { completedWaves: 5 }, { seed: "" },
        { seed: "x".repeat(201) }, { contentHash: "wrong" }, { state: {} },
        { commands: [NaN] }, { commands: [-1] }, { commands: [1.5] },
        { commands: [12287552] }, { commands: Array(5001).fill(0) }]
        .map((change) => ({ ...empty, checkpoint: { ...checkpoint, ...change } })),
    ]) expect(validate(value).ok).toBe(false);
  });
  it("fits the full 5000-command structural maximum inside the entire UTF-8 request limit", () => {
    const payload = { ...empty, clearedLevels: Array.from({ length: 25 }, (_, i) => i + 1),
      checkpoint: { ...checkpoint, seed: "\u0000".repeat(200), commands: Array(5000).fill(12287551) } };
    expect(validate(payload)).toEqual({ ok: true });
    const request = { schemaVersion: 1, baseRevision: Number.MAX_SAFE_INTEGER, payload,
      deviceId: "a".repeat(36), idempotencyKey: "b".repeat(36) };
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThan(MAX_BODY_BYTES);
  });
});
