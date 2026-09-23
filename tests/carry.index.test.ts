// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCarryClient } from "../src/carry/index";
import { createDomPromptHost } from "../src/saves/prompt";
import type { SenderWindow } from "../src/carry/send";
import type { ReceiverWindow } from "../src/carry/receive";

const GAME = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 } as const;
const OLD = "https://gridwatchmatchweb.warsignallabs.net";
const SETTINGS = { musicEnabled: true, sfxEnabled: false, voiceEnabled: true, reducedMotion: false };

// A trailing slash is how someone would naturally write an origin by hand; `sendCarry` compares
// `event.origin` to `nexusOrigin` with `===`, so a mismatch here silently times out every hand-off.
function harness() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opened = { closed: false, postMessage() {} };
  const calls: string[] = [];
  const win: SenderWindow & ReceiverWindow = {
    location: { origin: OLD, hash: "", href: `${OLD}/play/match/` },
    opener: null,
    history: { state: null, replaceState() {} },
    open(url: string, target: string) { calls.push(`${url} ${target}`); return opened; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const deliver = (data: unknown, origin: string, source: unknown = opened) => {
    for (const listener of [...listeners]) listener({ data, origin, source } as unknown as MessageEvent);
  };
  return { win, opened, calls, deliver };
}

describe("createCarryClient nexusOrigin normalisation", () => {
  it("strips a trailing slash from nexusOrigin so send opens the right URL and accepts a ready from the bare origin", async () => {
    const h = harness();
    const client = createCarryClient({
      game: GAME, nexusOrigin: "https://nexus.warsignallabs.net/", returnPath: "/play/match/",
      prompt: createDomPromptHost(), win: h.win,
    });
    const pending = client.send({ settings: SETTINGS });
    expect(h.calls).toEqual(["https://nexus.warsignallabs.net/play/match/#gw-carry _blank"]);
    h.deliver({ gw: "carry", v: 1, type: "ready", id: "n1" }, "https://nexus.warsignallabs.net");
    h.deliver({ gw: "carry", v: 1, type: "result", id: "n1", status: "accepted" }, "https://nexus.warsignallabs.net");
    await expect(pending).resolves.toBe("accepted");
  });
});

// A Nexus tab opened by a hand-off: #gw-carry present, an opener that records its posts.
function receiverHarness() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opener = { posted: [] as Array<{ message: any; targetOrigin: string }>,
    postMessage(message: unknown, targetOrigin: string) { this.posted.push({ message, targetOrigin }); } };
  const win = {
    location: { origin: "https://nexus.warsignallabs.net", hash: "#gw-carry", href: "https://nexus.warsignallabs.net/play/match/#gw-carry" },
    opener,
    history: { state: null, replaceState() {} },
    open() { return null; },
    addEventListener(_type: "message", listener: (event: MessageEvent) => void) { listeners.add(listener); },
    removeEventListener(_type: "message", listener: (event: MessageEvent) => void) { listeners.delete(listener); },
  } as SenderWindow & ReceiverWindow;
  const deliver = (data: unknown) => {
    for (const listener of [...listeners]) listener({ data, origin: OLD, source: opener } as unknown as MessageEvent);
  };
  return { win, opener, listeners, deliver };
}
const CARRY_GAME = { ...GAME, carryFrom: [OLD] };

// Final review item 3: a bad nexusOrigin (e.g. "" from an unset env var, which v0.2.6 tolerated)
// must not throw at construction; it surfaces, prefixed, only when a hand-off is attempted.
describe("createCarryClient with a bad nexusOrigin", () => {
  it("does not throw at construction; send throws an [account-kit] error instead", () => {
    const h = harness();
    let client: ReturnType<typeof createCarryClient> | undefined;
    expect(() => { client = createCarryClient({ game: GAME, nexusOrigin: "", returnPath: "/play/match/", prompt: createDomPromptHost(), win: h.win }); }).not.toThrow();
    expect(() => client!.send({ settings: SETTINGS })).toThrow(/^\[account-kit\] carry: invalid nexusOrigin ""/);
    expect(h.calls).toEqual([]);
  });
});

// Final review item 4: receive() is idempotent. A second call (React StrictMode, HMR) gets the
// first call's promise and never a second listener, so the cloud gate cannot start on an early
// "none" while the first handler is still applying the save (spec §6.4).
describe("createCarryClient receive idempotence", () => {
  it("returns the first receive promise on later calls and ignores the later handler", async () => {
    const h = receiverHarness();
    const client = createCarryClient({ game: CARRY_GAME, nexusOrigin: "https://nexus.warsignallabs.net", returnPath: "/play/match/", prompt: createDomPromptHost(), win: h.win });
    const first = vi.fn(async () => "accepted" as const);
    const second = vi.fn(async () => "declined" as const);
    const a = client.receive(first);
    const b = client.receive(second);
    expect(b).toBe(a);
    expect(h.listeners.size).toBe(1);
    expect(h.opener.posted.filter((p) => p.message.type === "ready")).toHaveLength(1);
    const id = h.opener.posted[0].message.id as string;
    h.deliver({ gw: "carry", v: 1, type: "offer", id, gameSlug: "gridwatch-match", schemaVersion: 1, slots: { settings: SETTINGS }, exportedAt: "2026-09-22T12:00:00.000Z" });
    await expect(b).resolves.toBe("accepted");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

// Final review item 5: the prompt host is shared with kit.saves, so kit.saves.dispose() rejects a
// pending replace prompt too. askReplace() must answer false (keep this site's), never reject.
describe("createCarryClient askReplace", () => {
  it("answers false when the shared prompt host is disposed while the replace prompt is open", async () => {
    const host = createDomPromptHost(document);
    const client = createCarryClient({ game: GAME, nexusOrigin: "https://nexus.warsignallabs.net", returnPath: "/play/match/", prompt: host, win: harness().win });
    const answer = client.askReplace();
    await vi.waitFor(() => expect(document.querySelector("dialog.gw-save-prompt")).not.toBeNull());
    host.dispose();
    await expect(answer).resolves.toBe(false);
  });

  it("answers false when the prompt host rejects", async () => {
    const client = createCarryClient({ game: GAME, nexusOrigin: "https://nexus.warsignallabs.net", returnPath: "/play/match/",
      prompt: { ask: () => Promise.reject(new Error("disposed")), dispose() {} }, win: harness().win });
    await expect(client.askReplace()).resolves.toBe(false);
  });

  it("still answers true for Replace and false for Keep this site's", async () => {
    const answers = ["primary", "secondary"] as const;
    let i = 0;
    const client = createCarryClient({ game: GAME, nexusOrigin: "https://nexus.warsignallabs.net", returnPath: "/play/match/",
      prompt: { ask: async () => answers[i++], dispose() {} }, win: harness().win });
    await expect(client.askReplace()).resolves.toBe(true);
    await expect(client.askReplace()).resolves.toBe(false);
  });
});

// Final review item 6: createCarryClient is exported, so it checks carryFrom itself rather than
// relying on createAccountKit — a hand-assembled ["*"] would otherwise post the ready nonce to "*".
describe("createCarryClient carryFrom check", () => {
  it("throws at construction on a carryFrom entry that is not an exact origin", () => {
    for (const bad of ["*", "https://*.warsignallabs.net", "http://gridwatchmatchweb.warsignallabs.net", `${OLD}/`]) {
      expect(() => createCarryClient({ game: { ...GAME, carryFrom: [bad] }, nexusOrigin: "https://nexus.warsignallabs.net",
        returnPath: "/play/match/", prompt: createDomPromptHost(), win: harness().win })).toThrow(/\[account-kit\] carryFrom/);
    }
    expect(() => createCarryClient({ game: CARRY_GAME, nexusOrigin: "https://nexus.warsignallabs.net",
      returnPath: "/play/match/", prompt: createDomPromptHost(), win: harness().win })).not.toThrow();
  });
});
