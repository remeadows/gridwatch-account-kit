import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setSupabaseForTests } from "../src/client";
import { createAccountKit } from "../src/session";

function fakeSupabase(session: unknown = null) {
  const listeners: Array<(e: string, s: unknown) => void> = [];
  const upsert = vi.fn(async () => ({ error: null }));
  const maybeSingle = vi.fn(async () => ({ data: { handle: "rusty" }, error: null }));
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => { listeners.push(cb); return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
      signInWithOtp: vi.fn(async () => ({ error: null })),
      signInWithOAuth: vi.fn(async () => ({ error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }), upsert })),
    __emit: (s: unknown) => listeners.forEach((l) => l("SIGNED_IN", s)),
    __upsert: upsert,
    __maybeSingle: maybeSingle,
  };
  __setSupabaseForTests(client as never);
  return client;
}

const user = { user: { id: "u1", email: "r@example.com" } };

describe("createAccountKit", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads the session and notifies subscribers on change", async () => {
    const sb = fakeSupabase(null);
    const kit = createAccountKit({ returnPath: "/play/match/" });
    expect(await kit.getSession()).toBeNull();
    const seen: unknown[] = [];
    const off = kit.onChange((s) => seen.push(s));
    sb.__emit(user);
    expect(seen).toEqual([user]);
    off();
  });

  it("loads the profile handle for the signed-in user and null when signed out", async () => {
    fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.getProfile()).toEqual({ handle: "rusty" });
    fakeSupabase(null);
    expect(await createAccountKit({ returnPath: "/" }).getProfile()).toEqual({ handle: null });
  });

  it("validates and upserts a handle, mapping 23505 to the taken message", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.saveHandle("bad space")).toBe("Handle must be 1-12 characters: letters, numbers, _ or -.");
    expect(await kit.saveHandle(" rusty ")).toBeNull();
    expect(sb.__upsert).toHaveBeenCalledWith({ user_id: "u1", handle: "rusty" });
    sb.__upsert.mockResolvedValueOnce({ error: { code: "23505", message: "dup" } } as never);
    expect(await kit.saveHandle("taken")).toBe("That handle is taken.");
    fakeSupabase(null);
    expect(await createAccountKit({ returnPath: "/" }).saveHandle("x")).toBe("Not signed in.");
  });

  it("sends the sign-in page as the default redirect and honours an explicit one", async () => {
    const sb = fakeSupabase(null);
    const kit = createAccountKit({ returnPath: "/play/match/" });
    await kit.signInWithEmail("r@example.com");
    expect(sb.auth.signInWithOtp).toHaveBeenCalledWith({ email: "r@example.com", options: { emailRedirectTo: "https://nexus.warsignallabs.net/account/sign-in?return=%2Fplay%2Fmatch%2F" } });
    await kit.signInWithProvider("github", { redirectTo: "https://nexus.warsignallabs.net/oauth/consent?authorization_id=abc" });
    expect(sb.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "github", options: { redirectTo: "https://nexus.warsignallabs.net/oauth/consent?authorization_id=abc" } });
    expect(kit.signInUrl()).toBe("https://nexus.warsignallabs.net/account/sign-in?return=%2Fplay%2Fmatch%2F");
  });

  it("never rejects from getSession: a thrown client error becomes null", async () => {
    const sb = fakeSupabase(null);
    sb.auth.getSession.mockRejectedValueOnce(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createAccountKit({ returnPath: "/" }).getSession()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns exactly null when the client reports an error alongside a session", async () => {
    const sb = fakeSupabase(user);
    sb.auth.getSession.mockResolvedValueOnce({ data: { session: user }, error: { message: "stale token" } } as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createAccountKit({ returnPath: "/" }).getSession()).toBeNull();
  });

  it("signOut calls auth.signOut once and resolves", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    await expect(kit.signOut()).resolves.toBeUndefined();
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1);
  });

  // D1: signOut() called auth.signOut() with no argument, whose default scope is GLOBAL — signing
  // out on one device revoked the player's session on every other device too (their phone kept
  // showing their name while every saves call answered 401).
  it("signs out of this browser only, leaving the player's other devices signed in", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    await kit.signOut();
    expect(sb.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("saveHandle returns the error message when the error object has no code", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    sb.__upsert.mockResolvedValueOnce({ error: { message: "constraint violation" } } as never);
    expect(await kit.saveHandle("rusty")).toBe("constraint violation");
  });

  it("returns the provider error message instead of throwing", async () => {
    const sb = fakeSupabase(null);
    sb.auth.signInWithOtp.mockResolvedValueOnce({ error: { message: "rate limited" } } as never);
    expect(await createAccountKit({ returnPath: "/" }).signInWithEmail("r@example.com")).toBe("rate limited");
  });

  it("getProfile and saveHandle survive a throwing auth.getSession (via the safe wrapper)", async () => {
    const sb = fakeSupabase(null);
    sb.auth.getSession.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.getProfile()).toEqual({ handle: null });
    expect(await kit.saveHandle("rusty")).toBe("Not signed in.");
  });

  // A1: signOut discards a returned Supabase error rather than surfacing it.
  it("signOut rejects with the error message when auth.signOut resolves a returned error", async () => {
    const sb = fakeSupabase(user);
    sb.auth.signOut.mockResolvedValueOnce({ error: { message: "nope" } } as never);
    const kit = createAccountKit({ returnPath: "/" });
    await expect(kit.signOut()).rejects.toThrow("nope");
  });

  it("signOut resolves when auth.signOut reports no error", async () => {
    const sb = fakeSupabase(user);
    sb.auth.signOut.mockResolvedValueOnce({ error: null } as never);
    const kit = createAccountKit({ returnPath: "/" });
    await expect(kit.signOut()).resolves.toBeUndefined();
  });

  // A2: getProfile silently converts a PostgREST error into a null handle instead of rejecting.
  it("getProfile rejects when the profile query resolves a PostgREST error", async () => {
    const sb = fakeSupabase(user);
    sb.__maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/" });
    await expect(kit.getProfile()).rejects.toThrow("boom");
  });

  it("getProfile resolves { handle: null } when data is null with no error", async () => {
    const sb = fakeSupabase(user);
    sb.__maybeSingle.mockResolvedValueOnce({ data: null, error: null } as never);
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.getProfile()).toEqual({ handle: null });
  });

  it("getProfile resolves the handle from data", async () => {
    fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.getProfile()).toEqual({ handle: "rusty" });
  });

  it("exposes saves only when a game config is given", () => {
    fakeSupabase(null);
    expect(createAccountKit({ returnPath: "/" }).saves).toBeUndefined();
    const kit = createAccountKit({ returnPath: "/play/match/", game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 } });
    expect(kit.saves?.game.routeAlias).toBe("match");
    expect(kit.config).toEqual({ returnPath: "/play/match/", nexusOrigin: "https://nexus.warsignallabs.net" });
    expect(() => kit.saves!.load("inventory")).toThrow(RangeError);
  });

  it("rejects a game config that doesn't match the saves registry", () => {
    fakeSupabase(null);
    // Transposed fields: gameSlug and routeAlias swapped.
    expect(() => createAccountKit({ returnPath: "/", game: { gameSlug: "match", routeAlias: "gridwatch-match", slots: ["campaign", "settings"], schemaVersion: 1 } })).toThrow(TypeError);
    // Unknown slot not in the registry for this game.
    expect(() => createAccountKit({ returnPath: "/", game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "inventory"], schemaVersion: 1 } })).toThrow(TypeError);
    // Wrong schemaVersion.
    expect(() => createAccountKit({ returnPath: "/", game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 2 } })).toThrow(TypeError);
    // The valid Match config must not throw.
    expect(() => createAccountKit({ returnPath: "/play/match/", game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 } })).not.toThrow();
  });

  it("strips a trailing slash from nexusOrigin before building the saves transport base URL", async () => {
    fakeSupabase(user);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "no_save" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchImpl);
    const kit = createAccountKit({
      returnPath: "/play/match/",
      nexusOrigin: "https://nexus.example/",
      game: { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 },
    });
    await kit.saves!.load("campaign");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://nexus.example/api/saves/match/campaign");
    expect(url.slice("https://".length)).not.toContain("//");
    vi.unstubAllGlobals();
  });
});
