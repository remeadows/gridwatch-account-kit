export declare function hasLoneSurrogate(text: string): boolean;
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(text: string): Promise<string>;
export interface RequestHashInput {
    game: string;
    slot: string;
    schemaVersion: number;
    baseRevision: number;
    payload: unknown;
}
/** SHA-256 over the canonical JSON of exactly { game, slot, schemaVersion, baseRevision, payload }.
 *
 *  The wrapper is serialized at depth -1, so the payload itself sits at depth 0 — exactly where
 *  validatePayload measures it from. Any payload the validator accepts (up to LIMITS.maxDepth) can
 *  therefore be hashed, and one level deeper is still refused, with the same "deeper than" limit. */
export declare function requestHash(input: RequestHashInput): Promise<string>;
