import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCarry, type SenderWindow } from "../src/carry/send";

const GAME = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 } as const;
const NEXUS = "https://nexus.warsignallabs.net";
const OLD = "https://gridwatchmatchweb.warsignallabs.net";
const SETTINGS = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };

function harness(options: { blocked?: boolean; origin?: string } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opened = { closed: false, posted: [] as Array<{ message: any; targetOrigin: string }>,
    postMessage(message: unknown, targetOrigin: string) { this.posted.push({ message, targetOrigin }); } };
  const calls: string[] = [];
  const win: SenderWindow = {
    location: { origin: options.origin ?? OLD },
    open(url: string, target: string) { calls.push(`${url} ${target}`); return options.blocked ? null : opened; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const deliver = (data: unknown, origin = NEXUS, source: unknown = opened) => {
    for (const listener of [...listeners]) listener({ data, origin, source } as unknown as MessageEvent);
  };
  const deps = { win, game: GAME, nexusOrigin: NEXUS, returnPath: "/play/match/", now: () => new Date("2026-09-22T12:00:00.000Z") };
  return { win, opened, deliver, listeners, calls, deps };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("sendCarry", () => {
  it("opens Nexus at returnPath#gw-carry in a new tab synchronously, before any await", () => {
    const h = harness();
    void sendCarry(h.deps, { settings: SETTINGS });
    expect(h.calls).toEqual([`${NEXUS}/play/match/#gw-carry _blank`]);
  });

  it("resolves blocked when the browser refuses the new tab", async () => {
    const h = harness({ blocked: true });
    await expect(sendCarry(h.deps, { settings: SETTINGS })).resolves.toBe("blocked");
  });

  it("answers a genuine ready with one offer to the Nexus origin (never '*') and resolves the matching result", async () => {
    const h = harness();
    const pending = sendCarry(h.deps, { settings: SETTINGS });
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" });
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n2" }); // a second ready is ignored
    expect(h.opened.posted).toEqual([{ targetOrigin: NEXUS, message: {
      gw: "carry", v: 1, type: "offer", id: "n1", gameSlug: "gridwatch-match", schemaVersion: 1,
      slots: { settings: SETTINGS }, exportedAt: "2026-09-22T12:00:00.000Z" } }]);
    h.deliver({ gw: "carry", v: 1, type: "result", id: "other", status: "accepted" }); // wrong id: ignored
    h.deliver({ gw: "carry", v: 1, type: "result", id: "n1", status: "declined" });
    await expect(pending).resolves.toBe("declined");
    expect(h.listeners.size).toBe(0);
  });

  it("ignores messages from another origin or another window", async () => {
    const h = harness();
    const pending = sendCarry(h.deps, { settings: SETTINGS });
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" }, "https://evil.example");
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" }, NEXUS, {});
    expect(h.opened.posted).toEqual([]);
    vi.advanceTimersByTime(20_000);
    await expect(pending).resolves.toBe("timeout");
  });

  it("resolves closed when the Nexus tab goes away before answering", async () => {
    const h = harness();
    const pending = sendCarry(h.deps, { settings: SETTINGS });
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" });
    h.opened.closed = true;
    vi.advanceTimersByTime(1_000);
    await expect(pending).resolves.toBe("closed");
  });

  it("does not time out while the player is answering the replace prompt", async () => {
    const h = harness();
    const pending = sendCarry(h.deps, { settings: SETTINGS });
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" });
    vi.advanceTimersByTime(120_000);
    h.deliver({ gw: "carry", v: 1, type: "result", id: "n1", status: "accepted" });
    await expect(pending).resolves.toBe("accepted");
  });

  it("refuses synchronously on the Nexus origin, with no slots, an unknown slot or an invalid payload", () => {
    expect(() => sendCarry(harness({ origin: NEXUS }).deps, { settings: SETTINGS })).toThrow(/Nexus origin/);
    expect(() => sendCarry(harness().deps, {})).toThrow(RangeError);
    expect(() => sendCarry(harness().deps, { secrets: {} } as never)).toThrow(RangeError);
    expect(() => sendCarry(harness().deps, { settings: { musicEnabled: "yes" } } as never)).toThrow(TypeError);
  });
});
