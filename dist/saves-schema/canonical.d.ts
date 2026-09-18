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
/** SHA-256 over the canonical JSON of exactly { game, slot, schemaVersion, baseRevision, payload }. */
export declare function requestHash(input: RequestHashInput): Promise<string>;
