// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAccountHeader } from "../src/header";
import type { AccountKit } from "../src/session";

function fakeKit(session: unknown, handle: string | null): AccountKit & { emit: (s: unknown) => void } {
  let listener: ((s: never) => void) | null = null;
  return {
    config: { returnPath: "/play/match/", nexusOrigin: "https://nexus.warsignallabs.net" },
    getSession: vi.fn(async () => session as never),
    onChange: vi.fn((cb) => { listener = cb; return () => { listener = null; }; }),
    signInWithEmail: vi.fn(), signInWithProvider: vi.fn(),
    signOut: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({ handle })),
    saveHandle: vi.fn(),
    signInUrl: () => "https://nexus.warsignallabs.net/account/sign-in?return=%2Fplay%2Fmatch%2F",
    emit: (s) => listener?.(s as never),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { document.body.innerHTML = ""; document.body.className = ""; });

describe("mountAccountHeader", () => {
  it("renders the signed-out bar with the sign-in link and brand", async () => {
    const kit = fakeKit(null, null);
    mountAccountHeader(kit);
    await tick();
    const bar = document.querySelector(".gw-account-bar")!;
    expect(bar.getAttribute("data-state")).toBe("signed-out");
    expect(document.body.classList.contains("gw-has-account-bar")).toBe(true);
    expect((bar.querySelector("a.gw-account-bar__brand") as HTMLAnchorElement).href).toBe("https://nexus.warsignallabs.net/");
    const signin = bar.querySelector("a.gw-account-bar__signin") as HTMLAnchorElement;
    expect(signin.textContent).toBe("Sign in");
    expect(signin.href).toBe(kit.signInUrl());
  });

  it("renders the handle chip and menu when signed in, and 'Set handle' when the profile has none", async () => {
    const kit = fakeKit({ user: { id: "u1" } }, "rusty");
    mountAccountHeader(kit);
    await tick();
    const bar = document.querySelector(".gw-account-bar")!;
    expect(bar.getAttribute("data-state")).toBe("signed-in");
    expect(bar.querySelector(".gw-account-bar__chip")!.textContent).toContain("rusty");
    const menu = bar.querySelector(".gw-account-bar__menu") as HTMLElement;
    expect(menu.hidden).toBe(true);
    (bar.querySelector(".gw-account-bar__chip") as HTMLButtonElement).click();
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll("button,a")].map((e) => e.textContent)).toEqual(["Switch account", "Sign out", "Back to Nexus"]);

    const kit2 = fakeKit({ user: { id: "u1" } }, null);
    document.body.innerHTML = "";
    mountAccountHeader(kit2);
    await tick();
    expect(document.querySelector(".gw-account-bar__chip")!.textContent).toContain("Set handle");
  });

  it("re-renders on session change and signs out from the menu", async () => {
    const kit = fakeKit(null, null);
    mountAccountHeader(kit);
    await tick();
    (kit.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({ handle: "rusty" });
    kit.emit({ user: { id: "u1" } });
    await tick();
    expect(document.querySelector(".gw-account-bar")!.getAttribute("data-state")).toBe("signed-in");
    (document.querySelector(".gw-account-bar__chip") as HTMLButtonElement).click();
    ([...document.querySelectorAll(".gw-account-bar__menu button")].find((b) => b.textContent === "Sign out") as HTMLButtonElement).click();
    await tick();
    expect(kit.signOut).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale profile result when a sign-out arrives while the profile is loading", async () => {
    const kit = fakeKit(null, null);
    let resolveProfile: (v: { handle: string | null }) => void = () => {};
    (kit.getProfile as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((r) => { resolveProfile = r; }));
    mountAccountHeader(kit);
    await tick();
    kit.emit({ user: { id: "u1" } });   // starts a profile load
    await tick();
    kit.emit(null);                      // signs out before the profile resolves
    await tick();
    resolveProfile({ handle: "rusty" }); // stale result
    await tick();
    expect(document.querySelector(".gw-account-bar")!.getAttribute("data-state")).toBe("signed-out");
  });

  it("defers the profile read out of the auth callback (signed-in event then profile read)", async () => {
    const kit = fakeKit(null, "rusty");
    mountAccountHeader(kit);
    await tick();
    kit.emit({ user: { id: "u1" } });
    expect(kit.getProfile).not.toHaveBeenCalled();   // nothing awaited synchronously inside the callback
    await tick();
    expect(kit.getProfile).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".gw-account-bar")!.getAttribute("data-state")).toBe("signed-in");
  });

  it("still renders signed-in (with 'Set handle') when the profile read rejects", async () => {
    const kit = fakeKit({ user: { id: "u1" } }, null);
    (kit.getProfile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("profiles unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountAccountHeader(kit);
    await tick();
    const bar = document.querySelector(".gw-account-bar")!;
    expect(bar.getAttribute("data-state")).toBe("signed-in");
    expect(bar.querySelector(".gw-account-bar__chip")!.textContent).toContain("Set handle");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to signed-out when the session read rejects", async () => {
    const kit = fakeKit(null, null);
    (kit.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("auth unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountAccountHeader(kit);
    await tick();
    expect(document.querySelector(".gw-account-bar")!.getAttribute("data-state")).toBe("signed-out");
    warn.mockRestore();
  });

  it("unmounts cleanly", async () => {
    const kit = fakeKit(null, null);
    const handle = mountAccountHeader(kit);
    await tick();
    handle.unmount();
    expect(document.querySelector(".gw-account-bar")).toBeNull();
    expect(document.body.classList.contains("gw-has-account-bar")).toBe(false);
  });
});
