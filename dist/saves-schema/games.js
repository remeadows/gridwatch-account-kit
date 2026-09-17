import { findDeniedKey } from "./denylist.js";
import { validateAgainst } from "./validate.js";
/** Alias → game. Only games wired to the kit client appear here; Zero keeps its own path (spec §2.3). */
export const SAVE_GAMES = Object.freeze({
    match: Object.freeze({ slug: "gridwatch-match", slots: Object.freeze(["campaign", "settings"]), schemaVersion: 1 }),
});
export function resolveSaveGame(alias) {
    return Object.hasOwn(SAVE_GAMES, alias) ? SAVE_GAMES[alias] : null;
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
export const payloadSchemas = Object.freeze({
    "gridwatch-match": Object.freeze({ 1: Object.freeze({ campaign: MATCH_CAMPAIGN_V1, settings: MATCH_SETTINGS_V1 }) }),
});
/** Schema check, then the recursive key denylist (spec §3.2). */
export function validatePayload(gameSlug, schemaVersion, slot, value) {
    const schema = payloadSchemas[gameSlug]?.[schemaVersion]?.[slot];
    if (!schema)
        return { ok: false, detail: "unknown_schema" };
    const structural = validateAgainst(schema, value);
    if (!structural.ok)
        return structural;
    const denied = findDeniedKey(value);
    return denied ? { ok: false, detail: `denied_key ${denied}` } : { ok: true };
}
