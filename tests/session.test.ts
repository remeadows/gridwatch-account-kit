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
});
