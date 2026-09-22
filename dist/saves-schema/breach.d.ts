import type { Schema } from "./validate.js";
/** Frozen v1 wire shape for breach / expansion-1-r4. Structural validation only:
 * the game must unpack commands and deterministically validate the checkpoint.
 * Scores, credentials and trusted simulation snapshots are deliberately absent. */
export declare const BREACH_EXPANSION_V1: Schema;
