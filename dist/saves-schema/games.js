import { findDeniedKey } from "./denylist.js";
import { validateAgainst } from "./validate.js";
/** Alias → game. Only games wired to the kit client appear here; Zero keeps its own path (spec §2.3).
 *  Typed sparse (`| undefined`) so every lookup site must guard instead of trusting a plain
 *  Record<string, SaveGame> index signature, which TypeScript otherwise treats as always present. */
export const SAVE_GAMES = Object.freeze({
    match: Object.freeze({ slug: "gridwatch-match", slots: Object.freeze(["campaign", "settings"]), schemaVersion: 1 }),
});
export function resolveSaveGame(alias) {
    return Object.hasOwn(SAVE_GAMES, alias) ? (SAVE_GAMES[alias] ?? null) : null;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Mirrors GridWatchMatchWeb src/state/save.ts SaveState v1 minus `version` and `settings`. */
export const MATCH_CAMPAIGN_V1 = {
    type: "object",
    properties: {
        coins: { type: "integer", min: 0 },
        boosters: { type: "record", keyPattern: /^[A-Za-z]{1,32}$/, value: { type: "integer", min: 0 } },
        selectedHeroId: { type: "string", maxLength: 64 },
        completedTutorial: { type: "boolean" },
        tutorialReplayRequested: { type: "boolean" },
        levels: {
            type: "record",
            keyPattern: ID,
            value: {
                type: "object",
                properties: {
                    stars: { type: "integer", min: 0, max: 3 },
                    score: { type: "integer", min: 0 },
                    completedAt: { type: "string", maxLength: 64 },
                },
            },
        },
        areaRewards: { type: "record", keyPattern: ID, value: { type: "boolean" } },
        intelSeen: { type: "record", keyPattern: ID, value: { type: "boolean" } },
    },
};
export const MATCH_SETTINGS_V1 = {
    type: "object",
    properties: {
        musicEnabled: { type: "boolean" },
        sfxEnabled: { type: "boolean" },
        voiceEnabled: { type: "boolean" },
        reducedMotion: { type: "boolean" },
    },
};
/** Sparse at every level (game slug, schema version, slot), for the same reason as SAVE_GAMES:
 *  an index signature typed without `| undefined` lets a lookup by an unregistered key compile
 *  as if it always returns a Schema, hiding exactly the kind of bug the hasOwn guards below exist
 *  to prevent. */
export const payloadSchemas = Object.freeze({
    "gridwatch-match": Object.freeze({ 1: Object.freeze({ campaign: MATCH_CAMPAIGN_V1, settings: MATCH_SETTINGS_V1 }) }),
});
/** Schema check, then the recursive key denylist (spec §3.2). Every lookup level is
 *  Object.hasOwn-guarded so a prototype-chain key ("__proto__", "constructor", "toString", ...)
 *  can never resolve to a schema that was never registered. */
export function validatePayload(gameSlug, schemaVersion, slot, value) {
    if (!Number.isInteger(schemaVersion))
        return { ok: false, detail: "unknown_schema" };
    const versions = Object.hasOwn(payloadSchemas, gameSlug) ? payloadSchemas[gameSlug] : undefined;
    const slots = versions && Object.hasOwn(versions, schemaVersion) ? versions[schemaVersion] : undefined;
    const schema = slots && Object.hasOwn(slots, slot) ? slots[slot] : undefined;
    if (!schema)
        return { ok: false, detail: "unknown_schema" };
    const structural = validateAgainst(schema, value);
    if (!structural.ok)
        return structural;
    const denied = findDeniedKey(value);
    return denied ? { ok: false, detail: `denied_key ${denied}` } : { ok: true };
}
