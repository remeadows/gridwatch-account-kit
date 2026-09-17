import type { StoreRequest } from "../saves-schema/wire.js";

export type TransportResult =
  | { kind: "ok"; status: number; body: unknown; retryAfterMs: number | null }
  | { kind: "network"; message: string };

export interface Transport {
  load(slot: string, token: string): Promise<TransportResult>;
  store(slot: string, body: StoreRequest, token: string): Promise<TransportResult>;
}

const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_MS = [500, 1500] as const;

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<TransportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (thrown) {
      // An abort (deadline exceeded) or any other fetch failure both map to "network" so the
      // existing retry/dirty handling runs exactly as it would for a dropped connection.
      return { kind: "network", message: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { kind: "ok", status: response.status, body, retryAfterMs: retryAfterMs(response) };
  } finally {
    // Keep the timer alive through response.json() (a hung body read must still be bounded by
    // the same deadline) and only clear it once this attempt is fully settled either way.
    clearTimeout(timer);
  }
}

export function createTransport(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = DEFAULT_TIMEOUT_MS): Transport {
  const url = (slot: string) => `${baseUrl}/${slot}`;
  return {
    load(slot, token) {
      return send(fetchImpl, url(slot), {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }, timeoutMs);
    },
    store(slot, body, token) {
      return send(fetchImpl, url(slot), {
        method: "PUT",
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, timeoutMs);
    },
  };
}

/** Bounded retry (spec §5.4): 3 attempts on network/5xx (500 ms, 1 500 ms); one Retry-After wait on 429. */
export async function withRetry(attempt: () => Promise<TransportResult>, sleep: (ms: number) => Promise<void>): Promise<TransportResult> {
  let failures = 0;
  let rateLimitedOnce = false;
  for (;;) {
    const result = await attempt();
    if (result.kind === "ok" && result.status === 429 && !rateLimitedOnce) {
      rateLimitedOnce = true;
      await sleep(Math.min(result.retryAfterMs ?? MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS));
      continue;
    }
    const transient = result.kind === "network" || result.status >= 500;
    if (!transient || failures >= BACKOFF_MS.length) return result;
    await sleep(BACKOFF_MS[failures]);
    failures += 1;
  }
}
