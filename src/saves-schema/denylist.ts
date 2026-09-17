// Recursive key denylist from spec §3.2. Keys only — values are the game's business.
import { LIMITS } from "./validate.js";

export const DENYLIST: readonly string[] = Object.freeze([
  "token", "refresh", "secret", "apikey", "analytics", "session", "jwt", "proof", "password", "credential",
]);

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDenied(key: string): boolean {
  const normalized = normalizeKey(key);
  return DENYLIST.some((word) => normalized.includes(word));
}

/** First denylisted key path (e.g. "$.profile.accessToken") or null when clean. */
export function findDeniedKey(value: unknown, path = "$", depth = 0): string | null {
  if (depth > LIMITS.maxDepth) throw new RangeError(`findDeniedKey: deeper than ${LIMITS.maxDepth}`);
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findDeniedKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDenied(key)) return `${path}.${key}`;
    const hit = findDeniedKey(child, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}
