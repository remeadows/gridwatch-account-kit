// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAccount } from "../src/react";
import type { AccountKit } from "../src/session";

function fakeKit(session: unknown, handle: string | null) {
  let listener: ((s: never) => void) | null = null;
  const kit = {
    config: { returnPath: "/", nexusOrigin: "https://nexus.warsignallabs.net" },
    getSession: vi.fn(async () => session as never),
    onChange: vi.fn((cb) => { listener = cb; return () => { listener = null; }; }),
    signInWithEmail: vi.fn(async () => null), signInWithProvider: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({ handle })),
    saveHandle: vi.fn(async () => null),
    signInUrl: () => "",
  } as unknown as AccountKit & { onChange: ReturnType<typeof vi.fn> };
  return { kit, emit: (s: unknown) => listener?.(s as never) };
}

describe("useAccount", () => {
  it("exposes session, handle, loading, and the sign-in functions with the useAuth shape", async () => {
    const { kit } = fakeKit({ user: { id: "u1" } }, "rusty");
    const { result } = renderHook(() => useAccount(kit));
    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toEqual({ user: { id: "u1" } });
    expect(result.current.handle).toBe("rusty");
    await act(async () => { await result.current.signInWithEmail("r@example.com", "https://x/"); });
    expect(kit.signInWithEmail).toHaveBeenCalledWith("r@example.com", { redirectTo: "https://x/" });
    await act(async () => { await result.current.signInWithProvider("google"); });
    expect(kit.signInWithProvider).toHaveBeenCalledWith("google", { redirectTo: undefined });
  });

  it("clears loading even if the initial session read rejects", async () => {
    const { kit } = fakeKit(null, null);
    (kit.getSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toBeNull();
  });

  it("keeps a newer auth event over a slower initial getSession", async () => {
    const { kit, emit } = fakeKit(null, null);
    let resolveSession: (v: unknown) => void = () => {};
    (kit.getSession as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => { resolveSession = r; }));
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => { emit({ user: { id: "u1" } }); });
    await act(async () => { resolveSession(null); });
    expect(result.current.session).toEqual({ user: { id: "u1" } });
    expect(result.current.loading).toBe(false);
  });

  it("updates handle after a successful saveHandle and follows session changes", async () => {
    const { kit, emit } = fakeKit(null, null);
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    expect(result.current.session).toBeNull();
    (kit.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({ handle: null });
    await act(async () => { emit({ user: { id: "u1" } }); });
    expect(result.current.session).toEqual({ user: { id: "u1" } });
    await act(async () => { expect(await result.current.saveHandle("rusty")).toBeNull(); });
    expect(result.current.handle).toBe("rusty");
  });
});
