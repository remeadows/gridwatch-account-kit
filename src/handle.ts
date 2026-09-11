export const HANDLE_RE = /^[A-Za-z0-9_-]{1,12}$/;

export function validateHandle(raw: string): string | null {
  return HANDLE_RE.test(raw.trim())
    ? null
    : "Handle must be 1-12 characters: letters, numbers, _ or -.";
}
