import { describe, expect, it } from "vitest";
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
