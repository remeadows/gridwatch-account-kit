const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_MS = [500, 1500];
function retryAfterMs(response) {
    const raw = response.headers.get("Retry-After");
    if (!raw)
        return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
const DEFAULT_TIMEOUT_MS = 15_000;
async function send(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        try {
            response = await fetchImpl(url, { ...init, signal: controller.signal });
        }
        catch (thrown) {
            // An abort (deadline exceeded) or any other fetch failure both map to "network" so the
            // existing retry/dirty handling runs exactly as it would for a dropped connection.
            return { kind: "network", message: thrown instanceof Error ? thrown.message : String(thrown) };
        }
        let body = null;
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        return { kind: "ok", status: response.status, body, retryAfterMs: retryAfterMs(response) };
    }
    finally {
        // Keep the timer alive through response.json() (a hung body read must still be bounded by
        // the same deadline) and only clear it once this attempt is fully settled either way.
        clearTimeout(timer);
    }
}
export function createTransport(baseUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const url = (slot) => `${baseUrl}/${slot}`;
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
export async function withRetry(attempt, sleep) {
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
        if (!transient || failures >= BACKOFF_MS.length)
            return result;
        await sleep(BACKOFF_MS[failures]);
        failures += 1;
    }
}
