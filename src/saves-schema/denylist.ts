// Recursive key denylist from spec §3.2. Keys only — values are the game's business.
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
export function findDeniedKey(value: unknown, path = "$"): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findDeniedKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDenied(key)) return `${path}.${key}`;
    const hit = findDeniedKey(child, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}
