// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAccount } from "../src/react";
import { expectConsole } from "./setup/consoleGuard";
import type { AccountKit } from "../src/session";

function fakeKit(session: unknown, handle: string | null) {
  let listener: ((s: never) => void) | null = null;
  const unsubscribe = vi.fn(() => { listener = null; });
  const kit = {
    config: { returnPath: "/", nexusOrigin: "https://nexus.warsignallabs.net" },
    getSession: vi.fn(async () => session as never),
    onChange: vi.fn((cb) => { listener = cb; return unsubscribe; }),
    signInWithEmail: vi.fn(async () => null), signInWithProvider: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({ handle })),
    saveHandle: vi.fn(async () => null),
    signInUrl: () => "",
  } as unknown as AccountKit & { onChange: ReturnType<typeof vi.fn> };
  return { kit, unsubscribe, emit: (s: unknown) => listener?.(s as never) };
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
    expectConsole("warn", "[account-kit] getSession rejected:");
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

  it("saveHandle passes the user id of the session the hook rendered with, so the kit can refuse a switched account", async () => {
    const { kit } = fakeKit({ user: { id: "u1" } }, null);
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await act(async () => { expect(await result.current.saveHandle("rusty")).toBeNull(); });
    expect(kit.saveHandle).toHaveBeenCalledWith("rusty", "u1");
  });

  it("saveHandle does not keep the display handle when the kit refuses a switched account", async () => {
    const { kit } = fakeKit({ user: { id: "u1" } }, "old");
    (kit.saveHandle as ReturnType<typeof vi.fn>).mockResolvedValueOnce("You're signed in as a different account now. Reload and try again.");
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await act(async () => { expect(await result.current.saveHandle("rusty")).toBe("You're signed in as a different account now. Reload and try again."); });
    expect(result.current.handle).toBe("old");
  });

  it("saveHandle from a signed-out render is refused without calling the kit", async () => {
    const { kit } = fakeKit(null, null);
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await act(async () => { expect(await result.current.saveHandle("rusty")).toBe("Not signed in."); });
    expect(kit.saveHandle).not.toHaveBeenCalled();
  });

  it("signOut from the hook calls the kit once", async () => {
    const { kit } = fakeKit(null, null);
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await act(async () => { await result.current.signOut(); });
    expect(kit.signOut).toHaveBeenCalledTimes(1);
  });

  it("releases the old subscription and re-reads the new kit's session when kit changes", async () => {
    const first = fakeKit({ user: { id: "u1" } }, "rusty");
    const second = fakeKit({ user: { id: "u2" } }, "other");
    const { result, rerender } = renderHook(({ kit }) => useAccount(kit), { initialProps: { kit: first.kit } });
    await act(async () => {});
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toEqual({ user: { id: "u1" } });
    expect(first.unsubscribe).not.toHaveBeenCalled();

    rerender({ kit: second.kit });
    expect(result.current.loading).toBe(true);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(second.kit.getSession).toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toEqual({ user: { id: "u2" } });
  });

  it("leaves handle null and does not throw when getProfile rejects", async () => {
    const { kit, emit } = fakeKit(null, null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (kit.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("profile fetch failed"));
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await act(async () => { emit({ user: { id: "u1" } }); });
    expect(result.current.handle).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  // A1 (hook ruling): a kit signOut rejection must not surface to the consumer.
  it("signOut resolves (never rejects) and warns when the kit's signOut rejects", async () => {
    const { kit } = fakeKit(null, null);
    (kit.signOut as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    await expect(act(async () => { await result.current.signOut(); })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[account-kit] signOut failed:", expect.anything());
  });

  // C2: switching users must not leak the previous user's handle when the new profile read fails.
  it("clears the handle on a user switch, even before the new profile read settles", async () => {
    const { kit, emit } = fakeKit({ user: { id: "u1" } }, "rusty");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useAccount(kit));
    await act(async () => {});
    expect(result.current.handle).toBe("rusty");

    (kit.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("profile fetch failed"));
    await act(async () => { emit({ user: { id: "u2" } }); });
    expect(result.current.handle).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
