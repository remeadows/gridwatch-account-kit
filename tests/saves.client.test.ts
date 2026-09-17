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

function harness(session: { access_token: string; user: { id: string } } | null = { access_token: "tok", user: { id: "u1" } }) {
  localStorage.clear();
  const load = vi.fn<Transport["load"]>();
  const store = vi.fn<Transport["store"]>();
  const answers: PromptAnswer[] = [];
  const asked: PromptCopy[] = [];
  const prompt = { ask: vi.fn(async (copy: PromptCopy) => { asked.push(copy); return answers.shift() ?? "primary"; }), dispose: vi.fn() };
  const state = createSaveStateStore(game.gameSlug);
  const client = createSavesClient({ game, getSession: async () => session, state, transport: { load, store }, prompt, sleep: async () => undefined, debounceMs: 0 });
  clients.push(client);
  return { client, load, store, prompt, answers, asked, state };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

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
});
