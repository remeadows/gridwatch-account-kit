import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveCarry, type ReceiverWindow } from "../src/carry/receive";
import { expectConsole } from "./setup/consoleGuard";

const OLD = "https://gridwatchmatchweb.warsignallabs.net";
const GAME = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1, carryFrom: [OLD, "http://localhost:4173"] } as const;
const SETTINGS = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };

function harness(options: { hash?: string; opener?: boolean; carryFrom?: readonly string[]; throwOnResult?: boolean; state?: unknown } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opener = { posted: [] as Array<{ message: any; targetOrigin: string }>,
    postMessage(message: unknown, targetOrigin: string) {
      // A severed or navigated-away opener can throw from postMessage; only the result post does here.
      if (options.throwOnResult && (message as { type?: string }).type === "result") throw new Error("opener gone");
      this.posted.push({ message, targetOrigin });
    } };
  const replaced: string[] = [];
  const replacedData: unknown[] = [];
  const hash = options.hash ?? "#gw-carry";
  const win: ReceiverWindow = {
    location: { hash, href: `https://nexus.warsignallabs.net/play/match/${hash}` },
    opener: options.opener === false ? null : opener,
    history: { state: options.state ?? null, replaceState(data, _unused, url) { replacedData.push(data); replaced.push(String(url)); } },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const deliver = (data: unknown, origin = OLD, source: unknown = opener) => {
    for (const listener of [...listeners]) listener({ data, origin, source } as unknown as MessageEvent);
  };
  const game = options.carryFrom === undefined ? GAME : { ...GAME, carryFrom: options.carryFrom };
  return { win, opener, deliver, listeners, replaced, replacedData, deps: { win, game, newId: () => "nonce-1" } };
}
const offer = (over: Record<string, unknown> = {}) => ({ gw: "carry", v: 1, type: "offer", id: "nonce-1", gameSlug: "gridwatch-match",
  schemaVersion: 1, slots: { settings: SETTINGS }, exportedAt: "2026-09-22T12:00:00.000Z", ...over });
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }; // setTimeout is faked

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("receiveCarry", () => {
  it("is none, and touches nothing, without the #gw-carry hash", async () => {
    const h = harness({ hash: "" });
    await expect(receiveCarry(h.deps, vi.fn())).resolves.toBe("none");
    expect(h.replaced).toEqual([]);
  });

  it("removes the hash synchronously, then is none without an opener or without carryFrom", async () => {
    const noOpener = harness({ opener: false });
    const pending = receiveCarry(noOpener.deps, vi.fn());
    expect(noOpener.replaced).toEqual(["https://nexus.warsignallabs.net/play/match/"]);
    await expect(pending).resolves.toBe("none");
    await expect(receiveCarry(harness({ carryFrom: [] }).deps, vi.fn())).resolves.toBe("none");
  });

  it("posts ready with one nonce to each carryFrom origin, never '*'", () => {
    const h = harness();
    void receiveCarry(h.deps, vi.fn());
    expect(h.opener.posted).toEqual([
      { targetOrigin: OLD, message: { gw: "carry", v: 1, type: "ready", id: "nonce-1" } },
      { targetOrigin: "http://localhost:4173", message: { gw: "carry", v: 1, type: "ready", id: "nonce-1" } },
    ]);
  });

  it("hands one valid offer to the handler and posts its answer back to the sender's origin", async () => {
    const h = harness();
    const handler = vi.fn(async () => "accepted" as const);
    const pending = receiveCarry(h.deps, handler);
    h.deliver(offer());
    h.deliver(offer()); // duplicate: ignored
    await expect(pending).resolves.toBe("accepted");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ slots: { settings: SETTINGS }, exportedAt: "2026-09-22T12:00:00.000Z", from: OLD });
    expect(h.opener.posted.at(-1)).toEqual({ targetOrigin: OLD, message: { gw: "carry", v: 1, type: "result", id: "nonce-1", status: "accepted" } });
    expect(h.listeners.size).toBe(0);
  });

  it("ignores an offer from an unlisted origin, another window or a wrong nonce", async () => {
    const h = harness();
    const handler = vi.fn(async () => "accepted" as const);
    const pending = receiveCarry(h.deps, handler);
    h.deliver(offer(), "https://evil.example");
    h.deliver(offer(), OLD, {});
    h.deliver(offer({ id: "guess" }));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    await expect(pending).resolves.toBe("none");
    expect(h.listeners.size).toBe(0);
  });

  it("rejects an invalid offer without calling the handler", async () => {
    expectConsole("warn", /carry offer rejected/);
    const h = harness();
    const handler = vi.fn(async () => "accepted" as const);
    const pending = receiveCarry(h.deps, handler);
    h.deliver(offer({ schemaVersion: 2 }));
    await expect(pending).resolves.toBe("rejected");
    expect(handler).not.toHaveBeenCalled();
    expect(h.opener.posted.at(-1)?.message).toMatchObject({ type: "result", status: "rejected" });
  });

  it("answers rejected when the handler throws", async () => {
    expectConsole("warn", /carry handler failed/);
    const h = harness();
    const pending = receiveCarry(h.deps, async () => { throw new Error("boom"); });
    h.deliver(offer());
    await expect(pending).resolves.toBe("rejected");
    expect(h.opener.posted.at(-1)?.message).toMatchObject({ type: "result", status: "rejected" });
  });
  // Final review item 1: a JS handler that forgets to return resolves undefined. That must not leak
  // out as an out-of-type result, nor be posted as a status the sender's readCarryMessage drops
  // (the sender would then wait until the Nexus tab closes).
  it("maps a handler answer other than accepted/declined to rejected, on both sides", async () => {
    const h = harness();
    const pending = receiveCarry(h.deps, (async () => undefined) as never);
    h.deliver(offer());
    await expect(pending).resolves.toBe("rejected");
    expect(h.opener.posted.at(-1)).toEqual({ targetOrigin: OLD, message: { gw: "carry", v: 1, type: "result", id: "nonce-1", status: "rejected" } });
  });

  // Final review item 2: the result post runs AFTER resolve, and a throwing post is contained,
  // so the receive promise settles on every path.
  it("still resolves the handler's answer when posting the result throws", async () => {
    expectConsole("warn", /carry result could not be posted/);
    const h = harness({ throwOnResult: true });
    let result: unknown = "pending";
    void receiveCarry(h.deps, async () => "accepted").then((r) => { result = r; });
    h.deliver(offer());
    await flush();
    expect(result).toBe("accepted");
  });

  it("still resolves rejected when posting the rejection of an invalid offer throws", async () => {
    expectConsole("warn", /carry offer rejected/);
    expectConsole("warn", /carry result could not be posted/);
    const h = harness({ throwOnResult: true });
    let result: unknown = "pending";
    void receiveCarry(h.deps, vi.fn()).then((r) => { result = r; });
    expect(() => h.deliver(offer({ schemaVersion: 2 }))).not.toThrow();
    await flush();
    expect(result).toBe("rejected");
  });

  it("still resolves rejected when posting after a handler failure throws", async () => {
    expectConsole("warn", /carry handler failed/);
    expectConsole("warn", /carry result could not be posted/);
    const h = harness({ throwOnResult: true });
    let result: unknown = "pending";
    void receiveCarry(h.deps, async () => { throw new Error("boom"); }).then((r) => { result = r; });
    h.deliver(offer());
    await flush();
    expect(result).toBe("rejected");
  });

  it("settles rejected, without the handler, when checking the offer itself throws", async () => {
    expectConsole("warn", /carry offer failed/);
    const h = harness();
    const handler = vi.fn(async () => "accepted" as const);
    let result: unknown = "pending";
    void receiveCarry(h.deps, handler).then((r) => { result = r; });
    const slots = Object.defineProperty({}, "settings", { enumerable: true, get() { throw new Error("hostile getter"); } });
    expect(() => h.deliver(offer({ slots }))).not.toThrow();
    await flush();
    expect(result).toBe("rejected");
    expect(handler).not.toHaveBeenCalled();
    expect(h.opener.posted.at(-1)?.message).toMatchObject({ type: "result", id: "nonce-1", status: "rejected" });
  });

  // Final review item 8: stripping the hash must not clobber the page's existing history.state.
  it("keeps history.state when it strips the hash", () => {
    const h = harness({ state: { route: "match" } });
    void receiveCarry(h.deps, vi.fn());
    expect(h.replacedData).toEqual([{ route: "match" }]);
  });
});
