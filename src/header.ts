import type { Session } from "@supabase/supabase-js";
import type { AccountKit } from "./session.js";

export interface MountOptions { container?: HTMLElement }
export interface MountedHeader { unmount(): void; refresh(): Promise<void> }

type State = "loading" | "signed-out" | "signed-in";

const SIGN_OUT_FAILED_TEXT = "Sign out failed — try again.";

// Module-level singleton: mountAccountHeader is idempotent while a bar is actually
// present in the document. If the caller wiped the DOM out from under us (rather than
// calling unmount()), `root.isConnected` goes false and we treat that as "not mounted".
let mountedInstance: { root: HTMLElement; header: MountedHeader; teardown: () => void } | null = null;

/** Always-visible account bar. Plain DOM so it mounts identically in React, Phaser, three.js, and vanilla apps. */
export function mountAccountHeader(kit: AccountKit, options: MountOptions = {}): MountedHeader {
  if (mountedInstance) {
    if (mountedInstance.root.isConnected) {
      return mountedInstance.header;
    }
    // The previous root was disconnected without an explicit unmount() (e.g. a router
    // did `document.body.innerHTML = ""`). Tear the abandoned instance down — unsubscribe
    // its onChange listener and drop its document listeners — before replacing it, so it
    // doesn't keep reacting to auth events or leak document-level handlers.
    mountedInstance.teardown();
    mountedInstance = null;
  }

  const host = options.container ?? document.body;
  const root = document.createElement("div");
  root.className = "gw-account-bar";
  root.setAttribute("role", "navigation");
  root.setAttribute("aria-label", "Account");
  root.setAttribute("data-state", "loading");
  host.prepend(root);
  document.body.classList.add("gw-has-account-bar");

  const nexusHome = `${kit.config.nexusOrigin}/`;

  let disposed = false;
  let lastRendered: { state: State; handle: string | null } | null = null;
  let lastKnownProfile: { userId: string; handle: string | null } | null = null;

  let currentMenu: HTMLElement | null = null;
  let currentChip: HTMLButtonElement | null = null;
  let notice: HTMLParagraphElement | null = null;

  function onDocKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") closeMenu();
  }
  function onDocClick(event: MouseEvent) {
    if (!root.contains(event.target as Node)) closeMenu();
  }
  function openMenu() {
    if (!currentMenu || !currentChip) return;
    currentMenu.hidden = false;
    currentChip.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onDocKeydown);
    document.addEventListener("click", onDocClick);
  }
  function closeMenu() {
    if (currentMenu) currentMenu.hidden = true;
    if (currentChip) currentChip.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onDocKeydown);
    document.removeEventListener("click", onDocClick);
  }

  async function handleSignOut(onSuccess: () => void) {
    try {
      await kit.signOut();
      if (notice) notice.hidden = true;
      onSuccess();
    } catch (thrown) {
      console.warn("[account-kit] header sign-out failed:", thrown instanceof Error ? thrown.message : String(thrown));
      if (notice) {
        notice.textContent = SIGN_OUT_FAILED_TEXT;
        notice.hidden = false;
      }
    }
  }

  function render(state: State, handle: string | null) {
    if (lastRendered && lastRendered.state === state && lastRendered.handle === handle) return;
    lastRendered = { state, handle };

    // Discard listeners/refs tied to the DOM we're about to replace.
    document.removeEventListener("keydown", onDocKeydown);
    document.removeEventListener("click", onDocClick);
    currentMenu = null;
    currentChip = null;
    notice = null;

    root.setAttribute("data-state", state);
    root.replaceChildren();

    const brand = el("a", "gw-account-bar__brand", "GridWatch") as HTMLAnchorElement;
    brand.href = nexusHome;
    root.append(brand);

    const right = el("div", "gw-account-bar__actions");
    root.append(right);

    if (state === "signed-in") {
      const chip = el("button", "gw-account-bar__chip") as HTMLButtonElement;
      chip.type = "button";
      chip.setAttribute("aria-haspopup", "menu");
      chip.setAttribute("aria-expanded", "false");
      chip.setAttribute("aria-controls", "gw-account-bar-menu");
      chip.append(el("span", "gw-account-bar__dot"), document.createTextNode(handle ?? "Set handle"));
      const menu = el("div", "gw-account-bar__menu") as HTMLDivElement;
      menu.id = "gw-account-bar-menu";
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      chip.addEventListener("click", () => { if (menu.hidden) openMenu(); else closeMenu(); });

      const switchBtn = el("button", "gw-account-bar__item", "Switch account") as HTMLButtonElement;
      switchBtn.type = "button";
      switchBtn.setAttribute("role", "menuitem");
      switchBtn.addEventListener("click", () => { void handleSignOut(() => window.location.assign(kit.signInUrl())); });
      const outBtn = el("button", "gw-account-bar__item", "Sign out") as HTMLButtonElement;
      outBtn.type = "button";
      outBtn.setAttribute("role", "menuitem");
      outBtn.addEventListener("click", () => { void handleSignOut(() => closeMenu()); });
      const back = el("a", "gw-account-bar__item", "Back to Nexus") as HTMLAnchorElement;
      back.href = nexusHome;
      back.setAttribute("role", "menuitem");
      menu.append(switchBtn, outBtn, back);
      right.append(chip, menu);

      const noticeEl = el("p", "gw-account-bar__notice") as HTMLParagraphElement;
      noticeEl.hidden = true;
      root.append(noticeEl);

      currentMenu = menu;
      currentChip = chip;
      notice = noticeEl;
    } else if (state === "signed-out") {
      const signin = el("a", "gw-account-bar__signin", "Sign in") as HTMLAnchorElement;
      signin.href = kit.signInUrl();
      right.append(signin);
    } else {
      right.append(el("span", "gw-account-bar__loading", "…"));
    }
  }

  // Each refresh gets a generation number; a slower older refresh must never overwrite a newer state.
  let generation = 0;
  async function refresh(session?: Session | null) {
    if (disposed) return;
    const mine = ++generation;
    let current: Session | null = null;
    try {
      current = session === undefined ? await kit.getSession() : session;
    } catch (thrown) {
      console.warn("[account-kit] header session read failed:", thrown instanceof Error ? thrown.message : String(thrown));
      current = null;
    }
    if (disposed || mine !== generation) return;
    if (!current) { render("signed-out", null); return; }
    const userId = current.user.id;
    let handle: string | null = null;
    try {
      const profile = await kit.getProfile();
      handle = profile.handle;
      lastKnownProfile = { userId, handle };
    } catch (thrown) {
      console.warn("[account-kit] header profile read failed:", thrown instanceof Error ? thrown.message : String(thrown));
      handle = lastKnownProfile && lastKnownProfile.userId === userId ? lastKnownProfile.handle : null;
    }
    if (disposed || mine !== generation) return;
    render("signed-in", handle);
  }

  render("loading", null);
  void refresh();
  // Supabase warns that awaiting Supabase calls inside onAuthStateChange can deadlock later
  // client calls, so the callback only schedules the refresh for the next macrotask.
  const off = kit.onChange((session) => { setTimeout(() => { void refresh(session); }, 0); });

  // Local cleanup only: unsubscribe from auth events and drop this instance's document
  // listeners. Always safe to call, including for an instance that was superseded rather
  // than explicitly unmounted (see the supersession branch above).
  function teardown() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("keydown", onDocKeydown);
    document.removeEventListener("click", onDocClick);
    off();
  }

  const header: MountedHeader = {
    unmount() {
      teardown();
      root.remove();
      // Only the currently-active instance may clear the shared body class / singleton —
      // a stale handle from a superseded mount must not disturb the live bar that replaced it.
      if (mountedInstance && mountedInstance.root === root) {
        document.body.classList.remove("gw-has-account-bar");
        mountedInstance = null;
      }
    },
    refresh: () => refresh(),
  };

  mountedInstance = { root, header, teardown };
  return header;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
