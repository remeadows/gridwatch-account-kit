export declare const DENYLIST: readonly string[];
export declare function normalizeKey(key: string): string;
/** First denylisted key path (e.g. "$.profile.accessToken") or null when clean. */
export declare function findDeniedKey(value: unknown, path?: string, depth?: number): string | null;
