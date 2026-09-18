// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavesClient } from "../src/saves/client";
import { CONFLICT_COPY, OWNERSHIP_COPY, createDomPromptHost, type PromptAnswer, type PromptCopy } from "../src/saves/prompt";
import { createSaveStateStore } from "../src/saves/state";
import type { Transport, TransportResult } from "../src/saves/transport";

const game = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 };
const campaign = { coins: 5, boosters: { rocket: 1 }, selectedHeroId: "rusty", completedTutorial: true, tutorialReplayRequested: false, levels: {}, areaRewards: {}, intelSeen: {} };
const row = (revision: number, payload = campaign) => ({ slot: "campaign", schemaVersion: 1, revision, payload, updatedAt: "2026-09-17T00:00:00.000Z" });
const ok = (status: number, body: unknown): TransportResult => ({ kind: "ok", status, body, retryAfterMs: null });

const clients: Array<{ dispose(): void }> = [];
afterEach(() => { for (const c of clients.splice(0)) c.dispose(); });

function harness(session: { access_token: string; user: { id: string } } | null = { access_token: "tok", user: { id: "u1" } }, debounceMs = 0) {
  localStorage.clear();
  let currentSession = session;
  const load = vi.fn<Transport["load"]>();
  const store = vi.fn<Transport["store"]>();
  const answers: PromptAnswer[] = [];
  const asked: PromptCopy[] = [];
  const prompt = { ask: vi.fn(async (copy: PromptCopy) => { asked.push(copy); return answers.shift() ?? "primary"; }), dispose: vi.fn() };
  const state = createSaveStateStore(game.gameSlug);
  const client = createSavesClient({ game, getSession: async () => currentSession, state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs });
  clients.push(client);
  const setSession = (next: { access_token: string; user: { id: string } } | null) => { currentSession = next; };
  return { client, load, store, prompt, answers, asked, state, setSession };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const flushDebounce = () => new Promise((r) => setTimeout(r, 80)); // outlasts a 40ms debounce window

describe("load", () => {
  it("maps wire replies", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(200, row(2)));
    expect(await h.client.load("campaign")).toEqual({ status: "ok", save: { revision: 2, schemaVersion: 1, payload: campaign, updatedAt: row(2).updatedAt } });
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    expect(await h.client.load("campaign")).toEqual({ status: "none" });
    h.load.mockResolvedValueOnce({ kind: "network", message: "down" })
      .mockResolvedValueOnce({ kind: "network", message: "down" })
      .mockResolvedValueOnce({ kind: "network", message: "down" });
    const failed = await h.client.load("campaign");
    expect(failed).toMatchObject({ status: "error", error: { code: "network", message: "down" } });
    expect(h.load).toHaveBeenCalledTimes(5);
    expect(() => h.client.load("inventory")).toThrow(RangeError);
    expect(await harness(null).client.load("campaign")).toEqual({ status: "signed_out" });
  });
  it("rejects an inbound cloud row with an invalid payload or the wrong slot instead of handing it to the game", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(200, row(2, { ...campaign, extra: 1 } as typeof campaign)));
    expect(await h.client.load("campaign")).toMatchObject({ status: "error", error: { code: "invalid_payload" } });
    h.load.mockResolvedValueOnce(ok(200, { ...row(2), slot: "settings" }));
    expect((await h.client.load("campaign")).status).toBe("error");
  });
  it("never rejects: a thrown getSession becomes a reportable error", async () => {
    const load = vi.fn<Transport["load"]>();
    const store = vi.fn<Transport["store"]>();
    const prompt = { ask: vi.fn(async () => "primary" as const), dispose: vi.fn() };
    const state = createSaveStateStore(game.gameSlug);
    const client = createSavesClient({ game, getSession: async () => { throw new Error("boom"); }, state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs: 0 });
    clients.push(client);
    await expect(client.load("campaign")).resolves.toEqual({ status: "error", error: { code: "http", message: "boom" } });
  });
});

describe("store", () => {
  it("rejects a bad payload locally without a request", async () => {
    const h = harness();
    const result = await h.client.store("campaign", { coins: -1 });
    expect(result).toMatchObject({ status: "error", error: { code: "invalid_payload" } });
    expect(h.store).not.toHaveBeenCalled();
  });
  it("sends baseRevision from the record, stores the new revision, marks ownership", async () => {
    const h = harness();
    h.state.writeRecord("u1", "campaign", { revision: 4, dirty: false });
    h.store.mockResolvedValueOnce(ok(200, { revision: 5, updatedAt: "t" }));
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 5, updatedAt: "t" });
    const [slot, body, token] = h.store.mock.calls[0];
    expect(slot).toBe("campaign");
    expect(token).toBe("tok");
    expect(body).toMatchObject({ schemaVersion: 1, baseRevision: 4, payload: campaign, deviceId: h.state.deviceId() });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    expect(h.state.readOwner("campaign")).toBe("u1");
  });
  it("coalesces calls within the debounce window into one flush with the last payload", async () => {
    const h = harness();
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    const [a, b] = await Promise.all([h.client.store("campaign", campaign), h.client.store("campaign", { ...campaign, coins: 9 })]);
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 9 });
    expect(a).toEqual(b);
  });
  it("marks dirty and returns error when retries are exhausted, then re-flushes on online", async () => {
    const h = harness();
    h.store.mockResolvedValue({ kind: "network", message: "offline" });
    expect((await h.client.store("campaign", campaign)).status).toBe("error");
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });
    h.store.mockReset();
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 1, dirty: false });
  });
  it("on 409 prompts once; 'Use cloud' loads the cloud row, 'Keep this one' re-sends on the cloud revision", async () => {
    const h = harness();
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    h.store.mockResolvedValueOnce(conflict);
    h.load.mockResolvedValueOnce(ok(200, row(7, { ...campaign, coins: 70 })));
    h.answers.push("primary");
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "use_cloud", save: { revision: 7, schemaVersion: 1, payload: { ...campaign, coins: 70 }, updatedAt: row(7).updatedAt } });
    expect(h.asked).toEqual([CONFLICT_COPY]);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 7, dirty: false });

    h.store.mockResolvedValueOnce(conflict).mockResolvedValueOnce(ok(200, { revision: 8, updatedAt: "t2" }));
    h.answers.push("secondary");
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 8, updatedAt: "t2" });
    const keys = h.store.mock.calls.map((c) => c[1].idempotencyKey);
    expect(h.store.mock.calls[2][1].baseRevision).toBe(7);
    expect(keys[2]).not.toBe(keys[1]);
  });
  it("returns signed_out without a request when there is no session", async () => {
    const h = harness(null);
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "signed_out" });
    expect(h.store).not.toHaveBeenCalled();
  });
  it("resolves a pending store instead of hanging when dispose() runs before the debounce timer fires", async () => {
    const h = harness();
    const promise = h.client.store("campaign", campaign);
    h.client.dispose();
    await expect(promise).resolves.toEqual({ status: "error", error: { code: "http", message: "disposed" } });
    expect(h.store).not.toHaveBeenCalled();
  });
  it("settles all waiters with an http error when the flush chain throws, without an unhandled rejection", async () => {
    const load = vi.fn<Transport["load"]>();
    const store = vi.fn<Transport["store"]>();
    const prompt = { ask: vi.fn(async () => "primary" as const), dispose: vi.fn() };
    const state = createSaveStateStore(game.gameSlug);
    const client = createSavesClient({
      game,
      getSession: async () => { throw new Error("boom"); },
      state,
      transport: { load, store },
      prompt,
      sleep: async () => undefined,
      debounceMs: 0,
    });
    clients.push(client);
    const result = await client.store("campaign", campaign);
    expect(result).toEqual({ status: "error", error: { code: "http", message: "boom" } });
    expect(store).not.toHaveBeenCalled();
  });
  it("treats a 409 with no safe-integer cloud.revision as a terminal error instead of looping", async () => {
    const h = harness();
    h.store.mockResolvedValueOnce(ok(409, { error: "conflict" })); // no cloud.revision at all
    const result = await h.client.store("campaign", campaign);
    expect(result).toEqual({ status: "error", error: { code: "http", status: 409, message: "malformed conflict" } });
    expect(h.prompt.ask).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });
  });
  it("rejects a request whose encoded body exceeds the 64 KB cap without calling the transport", async () => {
    const h = harness();
    const levels: Record<string, { stars: number; score: number; completedAt: string }> = {};
    for (let i = 0; i < 1200; i++) levels[String(i)] = { stars: 3, score: 1200, completedAt: "2026-09-17T10:00:00.000Z" };
    const big = { ...campaign, levels };
    const result = await h.client.store("campaign", big);
    expect(result).toEqual({ status: "error", error: { code: "invalid_payload", message: "request body exceeds 65536 bytes" } });
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toBeNull();
  });
  it("caps the conflict loop at 5 prompts and returns a terminal error instead of looping forever", async () => {
    const h = harness();
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    h.store.mockResolvedValue(conflict);
    h.answers.push("secondary", "secondary", "secondary", "secondary", "secondary");
    const result = await h.client.store("campaign", campaign);
    expect(result).toEqual({ status: "error", error: { code: "http", status: 409, message: "conflict retries exhausted" } });
    expect(h.prompt.ask).toHaveBeenCalledTimes(5);
    expect(h.store).toHaveBeenCalledTimes(6);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });
  });
  it("resolves disposed (writing no record) when the transport settles only after dispose() has already run", async () => {
    localStorage.clear();
    const load = vi.fn<Transport["load"]>();
    let resolveStore!: (r: TransportResult) => void;
    const store = vi.fn<Transport["store"]>(() => new Promise((resolve) => { resolveStore = resolve; }));
    const prompt = { ask: vi.fn(async () => "primary" as const), dispose: vi.fn() };
    const state = createSaveStateStore(game.gameSlug);
    const client = createSavesClient({ game, getSession: async () => ({ access_token: "tok", user: { id: "u1" } }), state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs: 0 });
    clients.push(client);
    const pending = client.store("campaign", campaign);
    await flush(); // let the debounce timer fire and the flush reach the (now hanging) transport call
    expect(store).toHaveBeenCalledTimes(1);
    client.dispose();
    resolveStore(ok(200, { revision: 1, updatedAt: "t" }));
    expect(await pending).toEqual({ status: "error", error: { code: "http", message: "disposed" } });
    expect(state.readRecord("u1", "campaign")).toBeNull();
  });
  it("dispose() closes an open conflict prompt and resolves the pending store as disposed", async () => {
    const load = vi.fn<Transport["load"]>();
    const store = vi.fn<Transport["store"]>();
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    store.mockResolvedValueOnce(conflict);
    const state = createSaveStateStore(game.gameSlug);
    const prompt = createDomPromptHost();
    const client = createSavesClient({ game, getSession: async () => ({ access_token: "tok", user: { id: "u1" } }), state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs: 0 });
    clients.push(client);
    const pending = client.store("campaign", campaign);
    await flush();
    expect(document.querySelector("dialog.gw-save-prompt")).not.toBeNull();
    client.dispose();
    expect(await pending).toEqual({ status: "error", error: { code: "http", message: "disposed" } });
    expect(document.querySelector("dialog.gw-save-prompt")).toBeNull();
  });
});

describe("reconcile", () => {
  it("uploads an unclaimed local save when there is no cloud row", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "uploaded", revision: 1 });
    expect(h.store.mock.calls[0][1].baseRevision).toBe(0);
    expect(h.state.readOwner("campaign")).toBe("u1");
  });
  it("asks before uploading another account's local save; 'Start fresh' claims the slot without uploading", async () => {
    const h = harness();
    h.state.writeOwner("campaign", "u9");
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    h.answers.push("secondary");
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "fresh" });
    expect(h.asked).toEqual([OWNERSHIP_COPY]);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readOwner("campaign")).toBe("u1");
  });
  it("hands back the cloud row when there is nothing local, and reports current when in sync", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(200, row(3)));
    expect(await h.client.reconcile("campaign", null)).toEqual({ status: "use_cloud", save: { revision: 3, schemaVersion: 1, payload: campaign, updatedAt: row(3).updatedAt } });
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });
    h.load.mockResolvedValueOnce(ok(200, row(3)));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "current" });
  });
  it("prompts on a never-synced local save with a cloud row", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(200, row(3)));
    h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t" }));
    h.answers.push("secondary");
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "stored", revision: 4 });
    expect(h.asked).toEqual([CONFLICT_COPY]);
    expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
  });
  it("'Use cloud' on a never-synced local save applies the loaded cloud row without a second load", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(200, row(3)));
    h.answers.push("primary");
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: { revision: 3, schemaVersion: 1, payload: campaign, updatedAt: row(3).updatedAt } });
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });
  });
  it("re-stores a dirty record that matches the cloud revision", async () => {
    const h = harness();
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: true });
    h.state.writeOwner("campaign", "u1");
    h.load.mockResolvedValueOnce(ok(200, row(3)));
    h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t" }));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "stored", revision: 4 });
    expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
  });
  it("returns signed_out and nothing where the table says so", async () => {
    expect(await harness(null).client.reconcile("campaign", campaign)).toEqual({ status: "signed_out" });
    const h = harness();
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    expect(await h.client.reconcile("campaign", null)).toEqual({ status: "nothing" });
  });
  it("throws synchronously on an unknown slot without sending anything", () => {
    const h = harness();
    expect(() => h.client.reconcile("inventory", null)).toThrow(RangeError);
    expect(h.store).not.toHaveBeenCalled();
  });
  it("validates the local payload before sending anything (migration path can carry denylisted keys)", async () => {
    const h = harness();
    const result = await h.client.reconcile("campaign", { ...campaign, sessionToken: "x" });
    expect(result).toMatchObject({ status: "error", error: { code: "invalid_payload" } });
    expect(h.load).not.toHaveBeenCalled();
    expect(h.store).not.toHaveBeenCalled();
  });
  it("never rejects: a thrown getSession becomes a reportable error", async () => {
    const load = vi.fn<Transport["load"]>();
    const store = vi.fn<Transport["store"]>();
    const prompt = { ask: vi.fn(async () => "primary" as const), dispose: vi.fn() };
    const state = createSaveStateStore(game.gameSlug);
    const client = createSavesClient({ game, getSession: async () => { throw new Error("boom"); }, state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs: 0 });
    clients.push(client);
    await expect(client.reconcile("campaign", null)).resolves.toEqual({ status: "error", error: { code: "http", message: "boom" } });
  });

  describe("localChanged hint", () => {
    it("turns a would-be silent use_cloud into a conflict prompt; 'Keep this one' sends local on the cloud revision", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(5)));
      h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t" }));
      h.answers.push("secondary");
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "stored", revision: 6 });
      expect(h.asked).toEqual([CONFLICT_COPY]);
      expect(h.store.mock.calls[0][1].baseRevision).toBe(5);
    });
    it("turns a would-be silent use_cloud into a conflict prompt; 'Use cloud' applies the cloud row and clears dirty", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(5)));
      h.answers.push("primary");
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "use_cloud", save: { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt } });
      expect(h.asked).toEqual([CONFLICT_COPY]);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    });
    it("without the hint, the same setup still answers use_cloud silently (regression guard)", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(5)));
      expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt } });
      expect(h.asked).toEqual([]);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    });
    it("at equal revisions uploads the local copy without a prompt", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(3)));
      h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t" }));
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "stored", revision: 4 });
      expect(h.asked).toEqual([]);
      expect(h.store).toHaveBeenCalledTimes(1);
      expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 4, dirty: false });
    });
    it("is ignored when local is null: no early dirty write, still a silent use_cloud", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(5)));
      const writeRecordSpy = vi.spyOn(h.state, "writeRecord");
      expect(await h.client.reconcile("campaign", null, { localChanged: true })).toEqual({ status: "use_cloud", save: { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt } });
      expect(h.asked).toEqual([]);
      expect(writeRecordSpy).toHaveBeenCalledTimes(1);
      expect(writeRecordSpy).toHaveBeenCalledWith("u1", "campaign", { revision: 5, dirty: false });
    });
    it("persists dirty before the cloud load, so a failed load still leaves the record protected", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" });
      const result = await h.client.reconcile("campaign", campaign, { localChanged: true });
      expect(result).toMatchObject({ status: "error", error: { code: "network", message: "down" } });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: true });
    });
    it("seeds lastPayload with the hinted local payload so a background re-flush after a failed load sends the player's actual edits, not an earlier store's stale payload", async () => {
      const h = harness();
      const olderPayload = campaign;
      const newerLocalEdits = { ...campaign, coins: 99 };
      h.store.mockResolvedValueOnce(ok(200, { revision: 3, updatedAt: "t0" }));
      expect(await h.client.store("campaign", olderPayload)).toEqual({ status: "stored", revision: 3, updatedAt: "t0" });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });

      h.load.mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" });
      const result = await h.client.reconcile("campaign", newerLocalEdits, { localChanged: true });
      expect(result).toMatchObject({ status: "error", error: { code: "network" } });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: true });

      h.store.mockReset();
      h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t1" }));
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).toHaveBeenCalledTimes(1);
      expect(h.store.mock.calls[0][1].payload).toEqual(newerLocalEdits);
      expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 4, dirty: false });
    });
    it("seeds lastPayload even when the record is ALREADY dirty, so the re-flush sends the hinted payload rather than an older remembered one", async () => {
      const h = harness();
      const olderPayload = campaign;
      const newerLocalEdits = { ...campaign, coins: 99 };
      h.store.mockResolvedValueOnce(ok(200, { revision: 3, updatedAt: "t0" }));
      expect(await h.client.store("campaign", olderPayload)).toEqual({ status: "stored", revision: 3, updatedAt: "t0" });
      // Dirty through an unrelated path (an earlier failed store or reconcile), so the hint block's
      // writeRecord is skipped: only the lastPayload seed is in question here.
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: true });

      h.load.mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" });
      expect(await h.client.reconcile("campaign", newerLocalEdits, { localChanged: true })).toMatchObject({ status: "error", error: { code: "network" } });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: true });

      h.store.mockReset();
      h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t1" }));
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).toHaveBeenCalledTimes(1);
      expect(h.store.mock.calls[0][1].payload).toEqual(newerLocalEdits);
      expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
    });
    it("seeds lastPayload on an ALREADY dirty record with nothing remembered yet, so the re-flush sends the hinted payload instead of skipping the slot", async () => {
      const h = harness();
      const newerLocalEdits = { ...campaign, coins: 99 };
      // Dirty with no remembered payload at all: this client instance never flushed this slot
      // (e.g. the record was left dirty in a previous page session).
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: true });
      h.state.writeOwner("campaign", "u1");

      h.load.mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" })
        .mockResolvedValueOnce({ kind: "network", message: "down" });
      expect(await h.client.reconcile("campaign", newerLocalEdits, { localChanged: true })).toMatchObject({ status: "error", error: { code: "network" } });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: true });

      h.store.mockResolvedValueOnce(ok(200, { revision: 4, updatedAt: "t1" }));
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).toHaveBeenCalledTimes(1);
      expect(h.store.mock.calls[0][1].payload).toEqual(newerLocalEdits);
      expect(h.store.mock.calls[0][1].baseRevision).toBe(3);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 4, dirty: false });
    });
    it("'Start fresh' after a hinted reconcile clears the pre-load dirty seed instead of leaving the discarded local payload flagged for background upload", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u9");
      h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
      h.answers.push("secondary");
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "fresh" });
      expect(h.asked).toEqual([OWNERSHIP_COPY]);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });

      h.store.mockClear();
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).not.toHaveBeenCalled();
    });
    it("'Start fresh' discards the local payload regardless of why the record was already dirty (hint block never fired here, since the record was dirty going in)", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: true });
      h.state.writeOwner("campaign", "u9");
      h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
      h.answers.push("secondary");
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "fresh" });
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });

      h.store.mockClear();
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).not.toHaveBeenCalled();
    });
    it("'Start fresh' with no record at all for this user+slot writes nothing (no throw)", async () => {
      const h = harness();
      h.state.writeOwner("campaign", "u9"); // owned by someone else; no record for u1 exists yet
      h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
      h.answers.push("secondary");
      expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "fresh" });
      expect(h.state.readRecord("u1", "campaign")).toBeNull();
    });
    it("the upload path (owner unset, no cloud row) still ends cleanly synced even when the hint marked the record dirty first", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 0, dirty: false });
      h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
      h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "uploaded", revision: 1 });
      expect(h.store.mock.calls[0][1].baseRevision).toBe(0);
      expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 1, dirty: false });
    });
    it("a hinted reconcile's conflict prompt answered 'Use cloud' clears the remembered payload, so a background re-flush later can't resurrect the discarded local edits", async () => {
      const h = harness();
      h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
      h.state.writeOwner("campaign", "u1");
      h.load.mockResolvedValueOnce(ok(200, row(5)));
      h.answers.push("primary");
      expect(await h.client.reconcile("campaign", campaign, { localChanged: true })).toEqual({ status: "use_cloud", save: { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt } });

      // Simulate the slot becoming dirty again through an unrelated path, to prove the discarded
      // payload is actually gone from lastPayload rather than merely "not currently dirty".
      h.state.writeRecord("u1", "campaign", { revision: 5, dirty: true });
      h.store.mockClear();
      window.dispatchEvent(new Event("online"));
      await flush();
      expect(h.store).not.toHaveBeenCalled();
    });
  });
  it("store()'s conflict prompt answered 'Use cloud' clears the remembered payload so a later background re-flush sends nothing for that slot", async () => {
    const h = harness();
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    h.store.mockResolvedValueOnce(conflict);
    h.load.mockResolvedValueOnce(ok(200, row(7, { ...campaign, coins: 70 })));
    h.answers.push("primary");
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "use_cloud", save: { revision: 7, schemaVersion: 1, payload: { ...campaign, coins: 70 }, updatedAt: row(7).updatedAt } });

    h.state.writeRecord("u1", "campaign", { revision: 7, dirty: true });
    h.store.mockClear();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).not.toHaveBeenCalled();
  });
  it("reconcile's unhinted use_cloud also clears the remembered payload", async () => {
    const h = harness();
    h.store.mockResolvedValueOnce(ok(200, { revision: 3, updatedAt: "t0" }));
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 3, updatedAt: "t0" });

    h.load.mockResolvedValueOnce(ok(200, row(5)));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt } });

    h.state.writeRecord("u1", "campaign", { revision: 5, dirty: true });
    h.store.mockClear();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).not.toHaveBeenCalled();
  });
});

describe("background re-flush", () => {
  it("never prompts on a background re-flush; a later reconcile with a newer cloud row still prompts as usual", async () => {
    const h = harness();
    h.store.mockResolvedValue({ kind: "network", message: "offline" });
    expect((await h.client.store("campaign", campaign)).status).toBe("error");
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });

    h.store.mockReset();
    h.store.mockResolvedValue(ok(409, { error: "conflict", cloud: { revision: 5, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } }));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.prompt.ask).not.toHaveBeenCalled();
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });

    h.store.mockReset();
    h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t3" }));
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    h.answers.push("secondary");
    const result = await h.client.reconcile("campaign", campaign);
    expect(h.asked).toEqual([CONFLICT_COPY]);
    expect(result).toEqual({ status: "stored", revision: 6 });
  });
  it("rechecks dirty inside the serialized quiet-flush callback: an online re-flush queued behind an open foreground conflict prompt must not re-upload the stale payload once 'Use cloud' has already cleared dirty", async () => {
    const h = harness();
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    h.store.mockResolvedValueOnce(conflict);
    h.load.mockResolvedValueOnce(ok(200, row(7, { ...campaign, coins: 70 })));
    let resolveAsk!: (a: PromptAnswer) => void;
    h.prompt.ask.mockImplementationOnce((copy: PromptCopy) => {
      h.asked.push(copy);
      return new Promise<PromptAnswer>((resolve) => { resolveAsk = resolve; });
    });
    const pending = h.client.store("campaign", campaign);
    await flush(); // let the debounce timer fire and the flush reach the (now open) conflict prompt
    expect(h.prompt.ask).toHaveBeenCalledTimes(1);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });

    // An online/visibilitychange event fires while the foreground prompt is still pending: it
    // queues a quiet re-flush of the same slot behind the running flush.
    window.dispatchEvent(new Event("online"));
    resolveAsk("primary"); // player picks "Use cloud"
    expect(await pending).toEqual({ status: "use_cloud", save: { revision: 7, schemaVersion: 1, payload: { ...campaign, coins: 70 }, updatedAt: row(7).updatedAt } });
    await flush(); // let the queued quiet re-flush actually run

    expect(h.store).toHaveBeenCalledTimes(1); // no second PUT from the stale queued re-flush
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 7, dirty: false });
  });
  it("never sends one account's remembered payload under another account's session, even though the client instance outlives sign-out/sign-in (cross-user repro)", async () => {
    const h = harness(); // starts as u1
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    // u1's payload is now remembered for background re-flush.

    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    // u2 has a dirty record but never called store() on this client instance — write it directly
    // through state so u1's remembered payload is the only thing a re-flush could possibly send.
    h.state.writeRecord("u2", "campaign", { revision: 0, dirty: true });

    h.store.mockReset();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).not.toHaveBeenCalled();
  });
  it("re-flushes an account's own payload again once it signs back in, after a background re-flush while another account was active correctly did nothing", async () => {
    const h = harness(); // starts as u1
    h.store.mockResolvedValue({ kind: "network", message: "offline" });
    expect((await h.client.store("campaign", campaign)).status).toBe("error");
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 0, dirty: true });

    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.store.mockReset();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).not.toHaveBeenCalled(); // nothing dirty for u2, and u1's payload must not leak

    h.setSession({ access_token: "tok", user: { id: "u1" } });
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t2" }));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][2]).toBe("tok"); // sent under u1's token
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 1, dirty: false });
  });
  it("re-checks the payload's owner at the moment it actually runs: an account switch while a quiet re-flush is queued behind other work for the slot must not send user A's payload under user B's session", async () => {
    const h = harness(); // starts as u1
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t0" }));
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 1, updatedAt: "t0" });
    // u1 is dirty again, with payload A ("campaign") still remembered from the store() above.
    h.state.writeRecord("u1", "campaign", { revision: 1, dirty: true });

    // Block the slot's serialized chain with a pending reconcile whose load we control.
    let resolveLoad!: (r: TransportResult) => void;
    h.load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const blocking = h.client.reconcile("campaign", null);

    // An online event fires while the chain is blocked: this queues quietFlush(slot, A, "u1")
    // behind the still-running reconcile in the slot's serialized queue.
    window.dispatchEvent(new Event("online"));
    await flush();

    // The account switches to U2 while the quiet flush is still queued, not yet running.
    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.state.writeRecord("u2", "campaign", { revision: 5, dirty: true });

    h.store.mockClear();
    resolveLoad(ok(404, { error: "no_save" })); // release the blocked reconcile
    await blocking;
    await flush(); // let the queued quiet re-flush actually run

    expect(h.store).not.toHaveBeenCalled(); // A never sent under U2's session
    expect(h.state.readRecord("u2", "campaign")).toEqual({ revision: 5, dirty: true }); // untouched
  });
});

describe("store is bound to the user who made it (foreground debounce, not just background re-flush)", () => {
  it("drops the flush when a different user is signed in by the time the debounce timer fires", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId with a real u1 session
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeRecord("u2", "campaign", { revision: 8, dirty: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok2", user: { id: "u2" } }); // switch inside the debounce window
    expect(await pending).toEqual({ status: "signed_out" });
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u2", "campaign")).toEqual({ revision: 8, dirty: false });
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store made by a different user");
    warn.mockRestore();

    // Prove the dropped commit never reached lastPayload under u2's key either: force u2's record
    // dirty through an unrelated path and confirm a background re-flush still sends nothing.
    h.state.writeRecord("u2", "campaign", { revision: 8, dirty: true });
    h.store.mockClear();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.store).not.toHaveBeenCalled();
  });

  it("still flushes when the same user's session is merely refreshed (new token, same id) inside the debounce window", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));

    const pending = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok-refreshed", user: { id: "u1" } }); // token refresh, same user
    expect(await pending).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][2]).toBe("tok-refreshed");
  });

  it("a commit made while signed out is attributed to the last known user: a DIFFERENT sign-in before the timer fires drops it", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.setSession(null); // signs out
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok2", user: { id: "u2" } }); // a DIFFERENT user signs in before the timer fires
    expect(await pending).toEqual({ status: "signed_out" });
    expect(h.store).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store made by a different user");
    warn.mockRestore();
  });

  it("a commit made while signed out goes through once the SAME user signs back in before the timer fires", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.setSession(null); // signs out
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));

    const pending = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok", user: { id: "u1" } }); // the SAME user signs back in before the timer fires
    expect(await pending).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
  });

  it("coalesced store() calls keep the FIRST caller's forUser when the session merely changed without this client OBSERVING it yet: a user switch between the two calls still drops the single flush, for both waiters", async () => {
    // setSession() alone does not update lastKnownUserId — only an actual session() call inside
    // this client does (see load()/reconcile()/flush()). Since neither store() call below causes
    // one, lastKnownUserId is still "u1" when the second call happens, so it coalesces into the
    // SAME pending entry as the first (forUser stays "u1"); the single resulting flush then finds
    // u2 signed in and drops for both waiters. Contrast with the tests below, where an explicit
    // load() between the two store() calls DOES observe u2 first.
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok2", user: { id: "u2" } }); // switch between the two coalescing calls
    const second = h.client.store("campaign", { ...campaign, coins: 9 });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ status: "signed_out" });
    expect(b).toEqual({ status: "signed_out" });
    expect(h.store).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1); // one flush, one drop, both waiters settled from it
    warn.mockRestore();
  });

  it("does NOT coalesce across an OBSERVED user switch: the stale entry is dropped for its own waiter and a fresh entry starts for the new caller — dropped again if the session moves on before its own timer fires", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = h.client.store("campaign", campaign); // pending entry: forUser = u1

    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // this client now OBSERVES u2: lastKnownUserId becomes u2

    // Not coalesced: lastKnownUserId (u2) !== the pending entry's forUser (u1). The stale entry is
    // dropped for `first` right here, and a fresh entry (forUser: u2) starts for `second`.
    const second = h.client.store("campaign", { ...campaign, coins: 9 });
    expect(await first).toEqual({ status: "signed_out" });
    expect(h.store).not.toHaveBeenCalled();

    h.setSession({ access_token: "tok", user: { id: "u1" } }); // switches back before second's own timer fires
    expect(await second).toEqual({ status: "signed_out" }); // second's flush runs under u1 ≠ forUser u2
    expect(h.store).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2); // one drop-on-create (first), one drop-at-flush-time (second)
    warn.mockRestore();
  });

  it("does NOT coalesce across an OBSERVED user switch, but the new caller's own flush goes through normally when the session stays with them", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = h.client.store("campaign", campaign); // pending entry: forUser = u1

    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // observe u2

    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    const second = h.client.store("campaign", { ...campaign, coins: 9 }); // fresh entry: forUser = u2
    expect(await first).toEqual({ status: "signed_out" });

    expect(await second).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 9 });
    expect(h.store.mock.calls[0][2]).toBe("tok2");
    warn.mockRestore();
  });

  it("the very first store() before any session has ever resolved has no captured user and proceeds under whoever is signed in when the timer fires (documented residual)", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 40);
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    // Nothing has called load()/store()/reconcile() yet on this client, so lastKnownUserId is
    // still null: there is no prior user for this first commit to be checked against.
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
  });
});

describe("a discard drops every store the same user had already queued for that slot", () => {
  const discarded = { status: "error", error: { code: "http", message: "discarded" } };
  const stale = { ...campaign, coins: 1 };
  const cloud5 = { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt };

  it("drops a store whose debounce timer is still pending when a reconcile resolves use_cloud", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 200);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", stale); // timer still inside the 200 ms window
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    // record 3 < cloud 5 and not dirty, no hint: the table answers use_cloud outright.
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: cloud5 });

    expect(await pending).toEqual(discarded);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store the player discarded");
    warn.mockRestore();
  });

  it("drops a store whose flush is already queued in the slot chain behind a reconcile that resolves use_cloud", async () => {
    const h = harness();
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    let resolveLoad!: (r: TransportResult) => void;
    h.load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const blocking = h.client.reconcile("campaign", null);
    await flush(); // the reconcile observes u1 and blocks the slot chain on the controlled load
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", stale);
    await flush(); // its debounce timer fires: the flush is now QUEUED behind the blocked reconcile
    expect(h.store).not.toHaveBeenCalled();

    resolveLoad(ok(200, row(5)));
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });
    expect(await pending).toEqual(discarded);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    warn.mockRestore();
  });

  it("drops a store queued behind a hinted reconcile whose conflict prompt is answered 'Use cloud'", async () => {
    const h = harness();
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    let resolveAsk!: (a: PromptAnswer) => void;
    h.prompt.ask.mockImplementationOnce((copy: PromptCopy) => {
      h.asked.push(copy);
      return new Promise<PromptAnswer>((resolve) => { resolveAsk = resolve; });
    });
    const blocking = h.client.reconcile("campaign", campaign, { localChanged: true });
    await flush(); // the conflict prompt is open, still holding the slot chain
    expect(h.asked).toEqual([CONFLICT_COPY]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", stale);
    await flush(); // queued behind the reconcile

    resolveAsk("primary"); // the player picks "Use cloud"
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });
    expect(await pending).toEqual(discarded);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    warn.mockRestore();
  });

  it("drops a store queued behind an ownership prompt answered 'Start fresh'", async () => {
    const h = harness();
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u9"); // the slot belongs to another account
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    let resolveAsk!: (a: PromptAnswer) => void;
    h.prompt.ask.mockImplementationOnce((copy: PromptCopy) => {
      h.asked.push(copy);
      return new Promise<PromptAnswer>((resolve) => { resolveAsk = resolve; });
    });
    const blocking = h.client.reconcile("campaign", campaign);
    await flush();
    expect(h.asked).toEqual([OWNERSHIP_COPY]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = h.client.store("campaign", stale);
    await flush(); // queued behind the reconcile

    resolveAsk("secondary"); // the player picks "Start fresh"
    expect(await blocking).toEqual({ status: "fresh" });
    expect(await pending).toEqual(discarded);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });
    warn.mockRestore();
  });

  it("a store whose OWN flush reaches the conflict prompt still resolves use_cloud, while a second store queued behind it is discarded", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1, so the first store captures an epoch too
    const conflict = ok(409, { error: "conflict", cloud: { revision: 7, updatedAt: "t", summary: { schemaVersion: 1, sizeBytes: 2, payloadDigest: "ab", deviceId: null } } });
    h.store.mockResolvedValueOnce(conflict);
    h.load.mockResolvedValueOnce(ok(200, row(7, { ...campaign, coins: 70 })));
    let resolveAsk!: (a: PromptAnswer) => void;
    h.prompt.ask.mockImplementationOnce((copy: PromptCopy) => {
      h.asked.push(copy);
      return new Promise<PromptAnswer>((resolve) => { resolveAsk = resolve; });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = h.client.store("campaign", campaign);
    await flush(); // first's flush ran, got a 409, and is holding the conflict prompt open
    expect(h.prompt.ask).toHaveBeenCalledTimes(1);

    const second = h.client.store("campaign", stale);
    await flush(); // second's flush is queued behind first

    resolveAsk("primary");
    // The discard is raised by first's OWN operation: first must still report its legitimate
    // use_cloud result (its epoch check already ran, at the top of its flush).
    expect(await first).toEqual({ status: "use_cloud", save: { revision: 7, schemaVersion: 1, payload: { ...campaign, coins: 70 }, updatedAt: row(7).updatedAt } });
    expect(await second).toEqual(discarded);
    expect(h.store).toHaveBeenCalledTimes(1); // only first's PUT
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 7, dirty: false });
    warn.mockRestore();
  });

  it("a store issued AFTER the discard captures the new epoch and goes through normally", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: cloud5 });

    h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t" }));
    expect(await h.client.store("campaign", { ...campaign, coins: 2 })).toEqual({ status: "stored", revision: 6, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].baseRevision).toBe(5);
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 6, dirty: false });
  });

  it("a background quiet re-flush queued behind a reconcile that resolves use_cloud sends nothing", async () => {
    const h = harness();
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t0" }));
    expect(await h.client.store("campaign", campaign)).toEqual({ status: "stored", revision: 1, updatedAt: "t0" });
    h.state.writeRecord("u1", "campaign", { revision: 1, dirty: true }); // dirty again, payload still remembered

    let resolveLoad!: (r: TransportResult) => void;
    h.load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const blocking = h.client.reconcile("campaign", null);
    window.dispatchEvent(new Event("online")); // queues the quiet flush behind the blocked reconcile
    await flush();
    h.store.mockClear();

    resolveLoad(ok(200, row(5)));
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });
    await flush(); // let the queued quiet re-flush actually run

    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
  });

  it("epochs are per user: U1's discard does not drop a store U2 legitimately queued for the same slot", async () => {
    const h = harness(); // starts as u1
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: true });
    h.state.writeOwner("campaign", "u1");
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    let resolveAsk!: (a: PromptAnswer) => void;
    h.prompt.ask.mockImplementationOnce((copy: PromptCopy) => {
      h.asked.push(copy);
      return new Promise<PromptAnswer>((resolve) => { resolveAsk = resolve; });
    });
    // U1's reconcile resolves its session (u1) at the front of the slot chain, then blocks on the
    // conflict prompt while still holding that chain.
    const blocking = h.client.reconcile("campaign", campaign, { localChanged: true });
    await flush();
    expect(h.asked).toEqual([CONFLICT_COPY]);

    // While that prompt is open, U2 signs in. load() is not serialized, so it runs immediately and
    // this client OBSERVES u2 — U2's store therefore captures epochOf("u2", "campaign").
    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign");
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t2" }));
    const u2Store = h.client.store("campaign", { ...campaign, coins: 42 });
    await flush(); // U2's flush is queued behind U1's still-blocked reconcile

    resolveAsk("primary"); // U1 discards its local copy
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });

    // U2's queued store is for a different user's epoch and must still go through.
    expect(await u2Store).toEqual({ status: "stored", revision: 1, updatedAt: "t2" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 42 });
    expect(h.store.mock.calls[0][2]).toBe("tok2");
  });
});

describe("a discard also catches a store this client could not attribute to any user", () => {
  const discarded = { status: "error", error: { code: "http", message: "discarded" } };
  const cloud5 = { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt };

  // A harness whose getSession is BLOCKED until released, so the client has observed no session at
  // all while the test makes its first store() — the common startup shape: the game kicks off its
  // first reconcile and the player commits while that reconcile's session lookup is still pending.
  function gatedHarness(debounceMs = 0) {
    localStorage.clear();
    const load = vi.fn<Transport["load"]>();
    const store = vi.fn<Transport["store"]>();
    const answers: PromptAnswer[] = [];
    const asked: PromptCopy[] = [];
    const prompt = { ask: vi.fn(async (copy: PromptCopy) => { asked.push(copy); return answers.shift() ?? "primary"; }), dispose: vi.fn() };
    const state = createSaveStateStore(game.gameSlug);
    let releaseSession!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const getSession = vi.fn(async () => { await gate; return { access_token: "tok", user: { id: "u1" } }; });
    const client = createSavesClient({ game, getSession, state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs });
    clients.push(client);
    return { client, load, store, prompt, answers, asked, state, getSession, releaseSession };
  }

  it("a store made before ANY session was observed is dropped by a discard on that slot", async () => {
    const h = gatedHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    const blocking = h.client.reconcile("campaign", null);
    await flush();
    // The reconcile is stuck on its session lookup, so nothing has been observed yet: no cloud
    // request has even been made, which is what makes the store() below unattributable.
    expect(h.getSession).toHaveBeenCalledTimes(1);
    expect(h.load).not.toHaveBeenCalled();

    const pending = h.client.store("campaign", campaign);
    await flush(); // its timer fires; the flush queues behind the blocked reconcile

    h.releaseSession();
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });
    expect(await pending).toEqual(discarded);
    expect(h.store).not.toHaveBeenCalled();
    expect(h.state.readRecord("u1", "campaign")).toEqual({ revision: 5, dirty: false });
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store the player discarded");
    warn.mockRestore();
  });

  it("the same unattributed first store still goes through when no discard intervenes", async () => {
    const h = gatedHarness();
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    const blocking = h.client.reconcile("campaign", null); // resolves "nothing": no discard
    await flush();
    const pending = h.client.store("campaign", campaign);
    await flush();

    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    h.releaseSession();
    expect(await blocking).toEqual({ status: "nothing" });
    expect(await pending).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(h.store).toHaveBeenCalledTimes(1);
  });

  it("an unattributed entry left stale by a discard resolves discarded, and the next store (now attributable) goes through", async () => {
    const h = gatedHarness(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    const blocking = h.client.reconcile("campaign", null);
    await flush();
    const first = h.client.store("campaign", { ...campaign, coins: 1 }); // unattributed, still pending

    h.releaseSession();
    expect(await blocking).toEqual({ status: "use_cloud", save: cloud5 });
    // The client has now observed u1 (through the reconcile's own session lookup), so this second
    // call is attributable — and must not inherit the unattributed, pre-discard entry.
    h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t6" }));
    const second = h.client.store("campaign", { ...campaign, coins: 2 });

    expect(await first).toEqual(discarded);
    expect(await second).toEqual({ status: "stored", revision: 6, updatedAt: "t6" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 2 });
    expect(h.store.mock.calls[0][1].baseRevision).toBe(5);
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store the player discarded");
    expect(warn).not.toHaveBeenCalledWith("[account-kit] dropped a store made by a different user");
    warn.mockRestore();
  });
});

describe("a store made after a discard never coalesces into the pre-discard entry", () => {
  const discarded = { status: "error", error: { code: "http", message: "discarded" } };
  const cloud5 = { revision: 5, schemaVersion: 1, payload: campaign, updatedAt: row(5).updatedAt };

  it("the stale entry resolves discarded while the new commit goes through in its own flush", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 200);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Two calls coalesced into one pre-discard entry, to prove BOTH waiters are told and that the
    // drop warns once for the entry rather than once per waiter.
    const first = h.client.store("campaign", { ...campaign, coins: 1 });
    const alsoFirst = h.client.store("campaign", { ...campaign, coins: 3 });
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: cloud5 });

    h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t6" }));
    const second = h.client.store("campaign", { ...campaign, coins: 2 }); // same 200 ms window

    expect(await first).toEqual(discarded);
    expect(await alsoFirst).toEqual(discarded);
    expect(await second).toEqual({ status: "stored", revision: 6, updatedAt: "t6" });
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 2 });
    expect(h.store.mock.calls[0][1].baseRevision).toBe(5);
    expect(warn.mock.calls.filter((c) => c[0] === "[account-kit] dropped a store the player discarded")).toHaveLength(1);
    warn.mockRestore();
  });

  it("two same-owner stores with no discard between them still coalesce into one flush", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 200);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));

    const [a, b] = await Promise.all([
      h.client.store("campaign", campaign),
      h.client.store("campaign", { ...campaign, coins: 9 }),
    ]);
    expect(a).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(b).toEqual(a);
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.store.mock.calls[0][1].payload).toEqual({ ...campaign, coins: 9 });
  });

  // The two reasons an entry is replaced must stay distinct in what its waiters are told.
  it("reason 1: a stale entry replaced after an OBSERVED user switch still resolves signed_out", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 200);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const byU1 = h.client.store("campaign", campaign);
    h.setSession({ access_token: "tok2", user: { id: "u2" } });
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // OBSERVE u2
    h.store.mockResolvedValueOnce(ok(200, { revision: 1, updatedAt: "t" }));
    const byU2 = h.client.store("campaign", { ...campaign, coins: 9 }); // replaces u1's entry

    expect(await byU1).toEqual({ status: "signed_out" });
    expect(await byU2).toEqual({ status: "stored", revision: 1, updatedAt: "t" });
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store made by a different user");
    expect(warn).not.toHaveBeenCalledWith("[account-kit] dropped a store the player discarded");
    warn.mockRestore();
  });

  it("reason 2: a stale entry replaced after the SAME owner's discard resolves discarded", async () => {
    const h = harness({ access_token: "tok", user: { id: "u1" } }, 200);
    h.load.mockResolvedValueOnce(ok(404, { error: "no_save" }));
    await h.client.load("campaign"); // prime lastKnownUserId = u1
    h.state.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    h.state.writeOwner("campaign", "u1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const beforeDiscard = h.client.store("campaign", campaign);
    h.load.mockResolvedValueOnce(ok(200, row(5)));
    expect(await h.client.reconcile("campaign", campaign)).toEqual({ status: "use_cloud", save: cloud5 });
    h.store.mockResolvedValueOnce(ok(200, { revision: 6, updatedAt: "t6" }));
    const afterDiscard = h.client.store("campaign", { ...campaign, coins: 9 }); // replaces it

    expect(await beforeDiscard).toEqual(discarded);
    expect(await afterDiscard).toEqual({ status: "stored", revision: 6, updatedAt: "t6" });
    expect(warn).toHaveBeenCalledWith("[account-kit] dropped a store the player discarded");
    expect(warn).not.toHaveBeenCalledWith("[account-kit] dropped a store made by a different user");
    warn.mockRestore();
  });
});
