import { describe, expect, it } from "vitest";
import { resolveSaveGame, validatePayload } from "../src/saves-schema/games";
import { MAX_BODY_BYTES } from "../src/saves-schema/wire";

const progress = {
  best: { score: 4210, dist: 3120, rows: 6, date: "2026-09-20T18:02:11.412Z" },
  career: { welds: 12, rows: 6, gates: 3, dist: 3120, runs: 2 },
};
/** Validate through the registered Drift slot, not just its schema. */
const validate = (value: unknown) => validatePayload("grid-drift", 1, "progress", value);

describe("Drift progress save registry", () => {
  it("registers only the progress slot at schema version 1", () => {
    expect(resolveSaveGame("drift")).toEqual({ slug: "grid-drift", slots: ["progress"], schemaVersion: 1 });
    for (const slot of ["campaign", "settings", "achievements"]) {
      expect(validatePayload("grid-drift", 1, slot, progress)).toEqual({ ok: false, detail: "unknown_schema" });
    }
    expect(validatePayload("grid-drift", 2, "progress", progress).ok).toBe(false);
    expect(validatePayload("gridwatch-match", 1, "progress", progress).ok).toBe(false);
  });
  it("accepts a full ledger, and a ledger with no best yet", () => {
    expect(validate(progress)).toEqual({ ok: true });
    expect(validate({ career: progress.career })).toEqual({ ok: true });
  });
  it("rejects a missing career, unknown fields, negatives, fractions, nulls and auth blobs", () => {
    for (const value of [
      { best: progress.best },
      { ...progress, achievements: {} },
      { ...progress, lab: { graze: true } },
      { ...progress, career: { ...progress.career, runs: -1 } },
      { ...progress, career: { ...progress.career, dist: 1.5 } },
      { ...progress, career: { ...progress.career, extra: 1 } },
      { ...progress, best: { ...progress.best, score: "4210" } },
      { ...progress, best: { ...progress.best, date: "x".repeat(65) } },
      { ...progress, best: null },
      { ...progress, sessionToken: "never-store-credentials" },
    ]) expect(validate(value).ok).toBe(false);
  });
  it("fits the largest possible ledger inside the request limit", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const payload = {
      best: { score: max, dist: max, rows: max, date: "x".repeat(64) },
      career: { welds: max, rows: max, gates: max, dist: max, runs: max },
    };
    expect(validate(payload)).toEqual({ ok: true });
    const request = { schemaVersion: 1, baseRevision: max, payload, deviceId: "a".repeat(36), idempotencyKey: "b".repeat(36) };
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThan(MAX_BODY_BYTES);
  });
});
