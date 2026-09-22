import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
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

  // v0.1.3 backlog: a handle form opened for one account and submitted after the account changed
  // (another tab, a sign-out/sign-in) used to land on whoever was signed in at submit time.
  it("saveHandle with an expected user writes only while that user is still the signed-in one", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    expect(await kit.saveHandle("rusty", "u1")).toBeNull();
    expect(sb.__upsert).toHaveBeenCalledWith({ user_id: "u1", handle: "rusty" });
    sb.__upsert.mockClear();
    expect(await kit.saveHandle("rusty", "u2")).toBe("You're signed in as a different account now. Reload and try again.");
    expect(sb.__upsert).not.toHaveBeenCalled();
  });

  it("saveHandle re-reads the signed-in user at submit time: an account switch after the form opened is refused", async () => {
    const sb = fakeSupabase(user);
    const kit = createAccountKit({ returnPath: "/" });
    const openedFor = (await kit.getSession())!.user.id; // the form renders for u1
    sb.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u2" } } }, error: null } as never); // another tab switches account
    expect(await kit.saveHandle("rusty", openedFor)).toBe("You're signed in as a different account now. Reload and try again.");
    expect(sb.__upsert).not.toHaveBeenCalled();
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

// D2: the saves API validates every token with Supabase, so a session revoked elsewhere answers
// 401 while this device's cached JWT is still unexpired — the player kept seeing their name, and
// nothing synced, with nothing to tell them. The kit now wires the saves client's two recovery
// hooks: one refresh attempt, and, when that cannot help, an end to the LOCAL session so the
// header and useAccount fall back to "Sign in".
describe("a saves session the server rejects", () => {
  const matchGame = { gameSlug: "gridwatch-match", routeAlias: "match", slots: ["campaign", "settings"], schemaVersion: 1 };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const sessionFor = (id: string, token: string) => ({ access_token: token, user: { id, email: "r@example.com" } });
  const settled = () => new Promise((r) => setTimeout(r, 0)); // the notification is fire-and-forget
  const authHeader = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("Authorization");

  afterEach(() => { vi.unstubAllGlobals(); });

  it("maps auth.refreshSession into the kit's session shape and retries the request with the new token", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockResolvedValueOnce({ data: { session: sessionFor("u1", "tok2") }, error: null } as never);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(reply(404, { error: "no_save" }));
    vi.stubGlobal("fetch", fetchImpl);
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    expect(await kit.saves!.load("campaign")).toEqual({ status: "none" });
    expect(fetchImpl.mock.calls.map(authHeader)).toEqual(["Bearer tok", "Bearer tok2"]);
    await settled();
    expect(sb.auth.signOut).not.toHaveBeenCalled(); // recovered: the player stays signed in
    kit.saves!.dispose();
  });

  it("ends the LOCAL session when the rejected user is still the signed-in one", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "refresh_token_not_found" } } as never);
    const fetchImpl = vi.fn(async () => reply(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchImpl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    expect(await kit.saves!.load("campaign")).toMatchObject({ status: "error", error: { code: "http", status: 401 } });
    await settled();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a failed refresh is never retried
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1);
    expect(sb.auth.signOut).toHaveBeenCalledWith({ scope: "local" }); // local: the other devices are innocent
    warn.mockRestore();
    kit.saves!.dispose();
  });

  it("ends the local session once when several operations are rejected at the same time", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "refresh_token_not_found" } } as never);
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "unauthorized" })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    await Promise.all([kit.saves!.load("campaign"), kit.saves!.load("settings")]); // two slots, two rejections
    await settled();
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1); // one check-then-sign-out in flight, not one per rejection
    warn.mockRestore();
    kit.saves!.dispose();
  });

  it("gives each rejected user their own check: a stale rejection for u1 does not swallow u2's", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "refresh_token_not_found" } } as never);
    const held: Array<(r: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { held.push(resolve); })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    const first = kit.saves!.load("campaign"); // captured under u1
    await settled();
    sb.auth.getSession.mockResolvedValue({ data: { session: sessionFor("u2", "tok2") }, error: null } as never); // the browser is u2's now
    const second = kit.saves!.load("settings"); // captured under u2
    await settled();
    expect(held).toHaveLength(2);
    held[0](reply(401, { error: "unauthorized" })); // u1's stale rejection starts first…
    held[1](reply(401, { error: "unauthorized" })); // …and u2's overlaps it
    await Promise.all([first, second]);
    await settled();
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1); // u1's check finds u2 and does nothing; u2's own check signs out
    expect(sb.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    warn.mockRestore();
    kit.saves!.dispose();
  });

  it("reports a throwing auth.refreshSession as no recovery rather than failing the operation", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockRejectedValue(new Error("network down") as never);
    const fetchImpl = vi.fn(async () => reply(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchImpl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    expect(await kit.saves!.load("campaign")).toMatchObject({ status: "error", error: { code: "http", status: 401 } });
    await settled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sb.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    kit.saves!.dispose();
  });

  it("does nothing when the rejection names a user who is no longer the signed-in one", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.getSession
      .mockResolvedValueOnce({ data: { session: sessionFor("u1", "tok") }, error: null } as never)  // the saves call runs as u1
      .mockResolvedValue({ data: { session: sessionFor("u2", "tok2") }, error: null } as never);    // u2 has signed in since
    sb.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "gone" } } as never);
    const fetchImpl = vi.fn(async () => reply(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchImpl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    expect(await kit.saves!.load("campaign")).toMatchObject({ status: "error", error: { code: "http", status: 401 } });
    await settled();
    expect(sb.auth.signOut).not.toHaveBeenCalled(); // a stale rejection must not sign the current account out
    warn.mockRestore();
    kit.saves!.dispose();
  });

  it("contains a signOut that rejects while ending a rejected session", async () => {
    const sb = fakeSupabase(sessionFor("u1", "tok"));
    sb.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "gone" } } as never);
    sb.auth.signOut.mockRejectedValue(new Error("sign-out exploded") as never);
    const fetchImpl = vi.fn(async () => reply(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchImpl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createAccountKit({ returnPath: "/play/match/", game: matchGame });
    expect(await kit.saves!.load("campaign")).toMatchObject({ status: "error", error: { code: "http", status: 401 } });
    await settled();
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    kit.saves!.dispose();
  });
});
