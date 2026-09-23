import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveCarry, type ReceiverWindow } from "../src/carry/receive";
import { expectConsole } from "./setup/consoleGuard";

const OLD = "https://gridwatchmatchweb.warsignallabs.net";
const GAME = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1, carryFrom: [OLD, "http://localhost:4173"] } as const;
const SETTINGS = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };

function harness(options: { hash?: string; opener?: boolean; carryFrom?: readonly string[] } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opener = { posted: [] as Array<{ message: any; targetOrigin: string }>,
    postMessage(message: unknown, targetOrigin: string) { this.posted.push({ message, targetOrigin }); } };
  const replaced: string[] = [];
  const hash = options.hash ?? "#gw-carry";
  const win: ReceiverWindow = {
    location: { hash, href: `https://nexus.warsignallabs.net/play/match/${hash}` },
    opener: options.opener === false ? null : opener,
    history: { replaceState(_data, _unused, url) { replaced.push(String(url)); } },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const deliver = (data: unknown, origin = OLD, source: unknown = opener) => {
    for (const listener of [...listeners]) listener({ data, origin, source } as unknown as MessageEvent);
  };
  const game = options.carryFrom === undefined ? GAME : { ...GAME, carryFrom: options.carryFrom };
  return { win, opener, deliver, listeners, replaced, deps: { win, game, newId: () => "nonce-1" } };
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
});
