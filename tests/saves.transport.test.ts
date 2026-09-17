import { describe, expect, it, vi } from "vitest";
import { createTransport, withRetry, type TransportResult } from "../src/saves/transport";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("createTransport", () => {
  it("GETs the slot with the bearer token and no-store", async () => {
    const fetchImpl = vi.fn(async () => json(200, { slot: "campaign", revision: 1 }));
    const t = createTransport("https://nexus.example/api/saves/match", fetchImpl as never);
    expect(await t.load("campaign", "tok")).toEqual({ kind: "ok", status: 200, body: { slot: "campaign", revision: 1 }, retryAfterMs: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://nexus.example/api/saves/match/campaign");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(init.cache).toBe("no-store");
  });
  it("PUTs a JSON body and surfaces Retry-After in milliseconds", async () => {
    const fetchImpl = vi.fn(async () => json(429, { error: "rate_limited" }, { "Retry-After": "7" }));
    const t = createTransport("https://nexus.example/api/saves/match", fetchImpl as never);
    const body = { schemaVersion: 1, baseRevision: 0, payload: { coins: 1 }, deviceId: "d", idempotencyKey: "k" };
    expect(await t.store("settings", body, "tok")).toEqual({ kind: "ok", status: 429, body: { error: "rate_limited" }, retryAfterMs: 7000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://nexus.example/api/saves/match/settings");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
  it("reports thrown fetches and unparseable bodies", async () => {
    const t1 = createTransport("https://x", vi.fn(async () => { throw new TypeError("offline"); }) as never);
    expect(await t1.load("campaign", "tok")).toEqual({ kind: "network", message: "offline" });
    const t2 = createTransport("https://x", vi.fn(async () => new Response("<html>", { status: 502 })) as never);
    expect(await t2.load("campaign", "tok")).toEqual({ kind: "ok", status: 502, body: null, retryAfterMs: null });
  });
});

describe("withRetry", () => {
  const ok = (status: number, retryAfterMs: number | null = null): TransportResult => ({ kind: "ok", status, body: {}, retryAfterMs });
  it("returns a terminal status at once", async () => {
    const attempt = vi.fn(async () => ok(409));
    const sleep = vi.fn(async () => undefined);
    expect(await withRetry(attempt, sleep)).toEqual(ok(409));
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("retries network and 5xx three times with 500 then 1500 ms", async () => {
    const attempt = vi.fn<() => Promise<TransportResult>>()
      .mockResolvedValueOnce({ kind: "network", message: "x" })
      .mockResolvedValueOnce(ok(503))
      .mockResolvedValueOnce(ok(200));
    const sleep = vi.fn(async () => undefined);
    expect(await withRetry(attempt, sleep)).toEqual(ok(200));
    expect((sleep.mock.calls as unknown as [number][]).map((c) => c[0])).toEqual([500, 1500]);
  });
  it("gives up after the third failure", async () => {
    const attempt = vi.fn(async () => ok(500));
    expect(await withRetry(attempt, async () => undefined)).toEqual(ok(500));
    expect(attempt).toHaveBeenCalledTimes(3);
  });
  it("honours Retry-After once on 429 without consuming an attempt", async () => {
    const attempt = vi.fn<() => Promise<TransportResult>>()
      .mockResolvedValueOnce(ok(429, 2000))
      .mockResolvedValueOnce(ok(500))
      .mockResolvedValueOnce(ok(500))
      .mockResolvedValueOnce(ok(200));
    const sleep = vi.fn(async () => undefined);
    expect(await withRetry(attempt, sleep)).toEqual(ok(200));
    expect((sleep.mock.calls as unknown as [number][]).map((c) => c[0])).toEqual([2000, 500, 1500]);
    const again = vi.fn(async () => ok(429, 90_000));
    const sleep2 = vi.fn(async () => undefined);
    expect(await withRetry(again, sleep2)).toEqual(ok(429, 90_000));
    expect((sleep2.mock.calls as unknown as [number][]).map((c) => c[0])).toEqual([60_000]);
    expect(again).toHaveBeenCalledTimes(2);
  });
});
