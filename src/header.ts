import type { Session } from "@supabase/supabase-js";
import type { AccountKit } from "./session";

export interface MountOptions { container?: HTMLElement }
export interface MountedHeader { unmount(): void; refresh(): Promise<void> }

type State = "loading" | "signed-out" | "signed-in";

/** Always-visible account bar. Plain DOM so it mounts identically in React, Phaser, three.js, and vanilla apps. */
export function mountAccountHeader(kit: AccountKit, options: MountOptions = {}): MountedHeader {
  const host = options.container ?? document.body;
  const root = document.createElement("div");
  root.className = "gw-account-bar";
  root.setAttribute("role", "banner");
  root.setAttribute("data-state", "loading");
  host.prepend(root);
  document.body.classList.add("gw-has-account-bar");

  const nexusHome = `${kit.config.nexusOrigin}/`;

  function render(state: State, handle: string | null) {
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
      chip.append(el("span", "gw-account-bar__dot"), document.createTextNode(handle ?? "Set handle"));
      const menu = el("div", "gw-account-bar__menu") as HTMLDivElement;
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      chip.addEventListener("click", () => { menu.hidden = !menu.hidden; chip.setAttribute("aria-expanded", String(!menu.hidden)); });

      const switchBtn = el("button", "gw-account-bar__item", "Switch account") as HTMLButtonElement;
      switchBtn.type = "button";
      switchBtn.addEventListener("click", async () => { await kit.signOut(); window.location.assign(kit.signInUrl()); });
      const outBtn = el("button", "gw-account-bar__item", "Sign out") as HTMLButtonElement;
      outBtn.type = "button";
      outBtn.addEventListener("click", async () => { await kit.signOut(); menu.hidden = true; });
      const back = el("a", "gw-account-bar__item", "Back to Nexus") as HTMLAnchorElement;
      back.href = nexusHome;
      menu.append(switchBtn, outBtn, back);
      right.append(chip, menu);
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
    const mine = ++generation;
    let current: Session | null = null;
    try {
      current = session === undefined ? await kit.getSession() : session;
    } catch (thrown) {
      console.warn("[account-kit] header session read failed:", thrown instanceof Error ? thrown.message : String(thrown));
      current = null;
    }
    if (mine !== generation) return;
    if (!current) { render("signed-out", null); return; }
    let handle: string | null = null;
    try {
      handle = (await kit.getProfile()).handle;
    } catch (thrown) {
      console.warn("[account-kit] header profile read failed:", thrown instanceof Error ? thrown.message : String(thrown));
    }
    if (mine !== generation) return;
    render("signed-in", handle);
  }

  render("loading", null);
  void refresh();
  // Supabase warns that awaiting Supabase calls inside onAuthStateChange can deadlock later
  // client calls, so the callback only schedules the refresh for the next macrotask.
  const off = kit.onChange((session) => { setTimeout(() => { void refresh(session); }, 0); });

  return {
    unmount() { off(); root.remove(); document.body.classList.remove("gw-has-account-bar"); },
    refresh: () => refresh(),
  };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
