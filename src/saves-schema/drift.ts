import type { Schema } from "./validate.js";

const COUNT = { type: "integer", min: 0 } as const;

/** Frozen v1 wire shape for drift / progress: GRID DRIFT's personal best and career ledger
 * (GWTetrisRace game/cloud/progress.ts `projection`). `best` is omitted until the first run ends.
 * Achievements are deliberately absent: they sync through GRID DRIFT's own achievement_unlocks
 * route, which merges devices; a whole-slot save would make a player choose one device's badges. */
export const DRIFT_PROGRESS_V1: Schema = {
  type: "object",
  optional: ["best"],
  properties: {
    best: {
      type: "object",
      properties: { score: COUNT, dist: COUNT, rows: COUNT, date: { type: "string", maxLength: 64 } },
    },
    career: {
      type: "object",
      properties: { welds: COUNT, rows: COUNT, gates: COUNT, dist: COUNT, runs: COUNT },
    },
  },
};
