// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createSaveStateStore } from "../src/saves/state";

beforeEach(() => localStorage.clear());

describe("createSaveStateStore", () => {
  it("keeps records per user and per slot under the spec keys", () => {
    const store = createSaveStateStore("gridwatch-match");
    expect(store.readRecord("u1", "campaign")).toBeNull();
    store.writeRecord("u1", "campaign", { revision: 3, dirty: false });
    store.writeRecord("u2", "campaign", { revision: 1, dirty: true });
    expect(store.readRecord("u1", "campaign")).toEqual({ revision: 3, dirty: false });
    expect(store.readRecord("u2", "campaign")).toEqual({ revision: 1, dirty: true });
    expect(store.readRecord("u1", "settings")).toBeNull();
    expect(JSON.parse(localStorage.getItem("gw-account-kit.saves.gridwatch-match.campaign.u1.v1")!)).toEqual({ revision: 3, dirty: false });
  });
  it("tracks slot ownership", () => {
    const store = createSaveStateStore("gridwatch-match");
    expect(store.readOwner("campaign")).toBeNull();
    store.writeOwner("campaign", "u1");
    expect(store.readOwner("campaign")).toBe("u1");
    expect(JSON.parse(localStorage.getItem("gw-account-kit.saves.gridwatch-match.campaign.owner.v1")!)).toEqual({ userId: "u1" });
  });
  it("creates one device id per browser and shares it across games", () => {
    const a = createSaveStateStore("gridwatch-match").deviceId();
    const b = createSaveStateStore("grid-drift").deviceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
    expect(localStorage.getItem("gw-account-kit.device-id.v1")).toBe(a);
  });
  it("ignores corrupt records", () => {
    localStorage.setItem("gw-account-kit.saves.gridwatch-match.campaign.u1.v1", "{nope");
    localStorage.setItem("gw-account-kit.saves.gridwatch-match.campaign.owner.v1", '{"userId":5}');
    const store = createSaveStateStore("gridwatch-match");
    expect(store.readRecord("u1", "campaign")).toBeNull();
    expect(store.readOwner("campaign")).toBeNull();
  });
  it("falls back to memory when storage throws", () => {
    const throwing = { getItem() { throw new Error("private mode"); }, setItem() { throw new Error("private mode"); } } as unknown as Storage;
    const store = createSaveStateStore("gridwatch-match", throwing);
    store.writeRecord("u1", "campaign", { revision: 2, dirty: true });
    expect(store.readRecord("u1", "campaign")).toEqual({ revision: 2, dirty: true });
    expect(store.deviceId()).toBe(store.deviceId());
  });
});
