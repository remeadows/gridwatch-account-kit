/** Always-visible account bar. Plain DOM so it mounts identically in React, Phaser, three.js, and vanilla apps. */
export function mountAccountHeader(kit, options = {}) {
    const host = options.container ?? document.body;
    const root = document.createElement("div");
    root.className = "gw-account-bar";
    root.setAttribute("role", "banner");
    root.setAttribute("data-state", "loading");
    host.prepend(root);
    document.body.classList.add("gw-has-account-bar");
    const nexusHome = `${kit.config.nexusOrigin}/`;
    function render(state, handle) {
        root.setAttribute("data-state", state);
        root.replaceChildren();
        const brand = el("a", "gw-account-bar__brand", "GridWatch");
        brand.href = nexusHome;
        root.append(brand);
        const right = el("div", "gw-account-bar__actions");
        root.append(right);
        if (state === "signed-in") {
            const chip = el("button", "gw-account-bar__chip");
            chip.type = "button";
            chip.setAttribute("aria-haspopup", "menu");
            chip.append(el("span", "gw-account-bar__dot"), document.createTextNode(handle ?? "Set handle"));
            const menu = el("div", "gw-account-bar__menu");
            menu.setAttribute("role", "menu");
            menu.hidden = true;
            chip.addEventListener("click", () => { menu.hidden = !menu.hidden; chip.setAttribute("aria-expanded", String(!menu.hidden)); });
            const switchBtn = el("button", "gw-account-bar__item", "Switch account");
            switchBtn.type = "button";
            switchBtn.addEventListener("click", async () => { await kit.signOut(); window.location.assign(kit.signInUrl()); });
            const outBtn = el("button", "gw-account-bar__item", "Sign out");
            outBtn.type = "button";
            outBtn.addEventListener("click", async () => { await kit.signOut(); menu.hidden = true; });
            const back = el("a", "gw-account-bar__item", "Back to Nexus");
            back.href = nexusHome;
            menu.append(switchBtn, outBtn, back);
            right.append(chip, menu);
        }
        else if (state === "signed-out") {
            const signin = el("a", "gw-account-bar__signin", "Sign in");
            signin.href = kit.signInUrl();
            right.append(signin);
        }
        else {
            right.append(el("span", "gw-account-bar__loading", "…"));
        }
    }
    // Each refresh gets a generation number; a slower older refresh must never overwrite a newer state.
    let generation = 0;
    async function refresh(session) {
        const mine = ++generation;
        const current = session === undefined ? await kit.getSession() : session;
        if (mine !== generation)
            return;
        if (!current) {
            render("signed-out", null);
            return;
        }
        const { handle } = await kit.getProfile();
        if (mine !== generation)
            return;
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
function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
