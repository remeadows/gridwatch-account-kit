const SIGN_OUT_FAILED_TEXT = "Sign out failed — try again.";
// Module-level singleton: mountAccountHeader is idempotent while a bar is actually
// present in the document. If the caller wiped the DOM out from under us (rather than
// calling unmount()), `root.isConnected` goes false and we treat that as "not mounted".
// Dev-only note: a hot-module-reload that re-evaluates this module resets this singleton,
// so an HMR reload can yield a second bar in dev even though the DOM contract stays idempotent
// within one module instance.
let mountedInstance = null;
/** Always-visible account bar. Plain DOM so it mounts identically in React, Phaser, three.js, and vanilla apps. */
export function mountAccountHeader(kit, options = {}) {
    if (mountedInstance) {
        if (mountedInstance.root.isConnected) {
            if (mountedInstance.kit !== kit) {
                console.warn("[account-kit] mountAccountHeader: a bar is already mounted with a different kit; returning the existing mount");
            }
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
    let lastRendered = null;
    let lastKnownProfile = null;
    let currentMenu = null;
    let currentChip = null;
    let notice = null;
    function onDocKeydown(event) {
        if (event.key === "Escape") {
            closeMenu();
            currentChip?.focus();
        }
    }
    function onDocClick(event) {
        if (!root.contains(event.target))
            closeMenu();
    }
    function openMenu() {
        if (!currentMenu || !currentChip)
            return;
        currentMenu.hidden = false;
        currentChip.setAttribute("aria-expanded", "true");
        document.addEventListener("keydown", onDocKeydown);
        document.addEventListener("click", onDocClick);
    }
    function closeMenu() {
        if (currentMenu)
            currentMenu.hidden = true;
        if (currentChip)
            currentChip.setAttribute("aria-expanded", "false");
        document.removeEventListener("keydown", onDocKeydown);
        document.removeEventListener("click", onDocClick);
    }
    async function handleSignOut(onSuccess) {
        try {
            await kit.signOut();
            if (notice)
                notice.hidden = true;
            onSuccess();
        }
        catch (thrown) {
            console.warn("[account-kit] header sign-out failed:", thrown instanceof Error ? thrown.message : String(thrown));
            if (notice) {
                notice.textContent = SIGN_OUT_FAILED_TEXT;
                notice.hidden = false;
            }
        }
    }
    function render(state, handle) {
        if (lastRendered && lastRendered.state === state && lastRendered.handle === handle)
            return;
        lastRendered = { state, handle };
        // Discard listeners/refs tied to the DOM we're about to replace.
        document.removeEventListener("keydown", onDocKeydown);
        document.removeEventListener("click", onDocClick);
        currentMenu = null;
        currentChip = null;
        notice = null;
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
            chip.setAttribute("aria-expanded", "false");
            chip.setAttribute("aria-controls", "gw-account-bar-menu");
            chip.append(el("span", "gw-account-bar__dot"), document.createTextNode(handle ?? "Set handle"));
            const menu = el("div", "gw-account-bar__menu");
            menu.id = "gw-account-bar-menu";
            menu.setAttribute("role", "menu");
            menu.hidden = true;
            chip.addEventListener("click", () => { if (menu.hidden)
                openMenu();
            else
                closeMenu(); });
            const switchBtn = el("button", "gw-account-bar__item", "Switch account");
            switchBtn.type = "button";
            switchBtn.setAttribute("role", "menuitem");
            switchBtn.addEventListener("click", () => { void handleSignOut(() => window.location.assign(kit.signInUrl())); });
            const outBtn = el("button", "gw-account-bar__item", "Sign out");
            outBtn.type = "button";
            outBtn.setAttribute("role", "menuitem");
            outBtn.addEventListener("click", () => { void handleSignOut(() => closeMenu()); });
            const back = el("a", "gw-account-bar__item", "Back to Nexus");
            back.href = nexusHome;
            back.setAttribute("role", "menuitem");
            menu.append(switchBtn, outBtn, back);
            right.append(chip, menu);
            const noticeEl = el("p", "gw-account-bar__notice");
            noticeEl.hidden = true;
            noticeEl.setAttribute("role", "alert");
            root.append(noticeEl);
            currentMenu = menu;
            currentChip = chip;
            notice = noticeEl;
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
        if (disposed)
            return;
        const mine = ++generation;
        let current = null;
        try {
            current = session === undefined ? await kit.getSession() : session;
        }
        catch (thrown) {
            console.warn("[account-kit] header session read failed:", thrown instanceof Error ? thrown.message : String(thrown));
            current = null;
        }
        if (disposed || mine !== generation)
            return;
        if (!current) {
            render("signed-out", null);
            return;
        }
        const userId = current.user.id;
        let handle = null;
        try {
            const profile = await kit.getProfile();
            handle = profile.handle;
            // Only the still-current generation may update the shared cache — an obsolete refresh
            // that resolves late (or fails) must not clobber a newer generation's cached handle.
            if (!disposed && mine === generation)
                lastKnownProfile = { userId, handle };
        }
        catch (thrown) {
            console.warn("[account-kit] header profile read failed:", thrown instanceof Error ? thrown.message : String(thrown));
            handle = lastKnownProfile && lastKnownProfile.userId === userId ? lastKnownProfile.handle : null;
        }
        if (disposed || mine !== generation)
            return;
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
        if (disposed)
            return;
        disposed = true;
        document.removeEventListener("keydown", onDocKeydown);
        document.removeEventListener("click", onDocClick);
        off();
    }
    const header = {
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
    mountedInstance = { root, header, teardown, kit };
    return header;
}
function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
