// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavesClient } from "../src/saves/client";
import { CONFLICT_COPY, OWNERSHIP_COPY, type PromptAnswer, type PromptCopy } from "../src/saves/prompt";
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
  const prompt = { ask: vi.fn(async (copy: PromptCopy) => { asked.push(copy); return answers.shift() ?? "primary"; }) };
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
});
