import { type Schema, type ValidationResult } from "./validate.js";
export interface SaveGame {
    slug: string;
    slots: readonly string[];
    schemaVersion: number;
}
/** Alias → game. Only games wired to the kit client appear here; Zero keeps its own path (spec §2.3).
 *  Typed sparse (`| undefined`) so every lookup site must guard instead of trusting a plain
 *  Record<string, SaveGame> index signature, which TypeScript otherwise treats as always present. */
export declare const SAVE_GAMES: Readonly<Record<string, SaveGame | undefined>>;
export declare function resolveSaveGame(alias: string): SaveGame | null;
/** Mirrors GridWatchMatchWeb src/state/save.ts SaveState v1 minus `version` and `settings`. */
export declare const MATCH_CAMPAIGN_V1: Schema;
export declare const MATCH_SETTINGS_V1: Schema;
/** Sparse at every level (game slug, schema version, slot), for the same reason as SAVE_GAMES:
 *  an index signature typed without `| undefined` lets a lookup by an unregistered key compile
 *  as if it always returns a Schema, hiding exactly the kind of bug the hasOwn guards below exist
 *  to prevent. */
export declare const payloadSchemas: Readonly<Record<string, Readonly<Record<number, Readonly<Record<string, Schema | undefined>> | undefined>> | undefined>>;
/** Schema check, then the recursive key denylist (spec §3.2). Every lookup level is
 *  Object.hasOwn-guarded so a prototype-chain key ("__proto__", "constructor", "toString", ...)
 *  can never resolve to a schema that was never registered. */
export declare function validatePayload(gameSlug: string, schemaVersion: number, slot: string, value: unknown): ValidationResult;
