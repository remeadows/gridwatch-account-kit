import { validatePayload } from "../saves-schema/games.js";
import { CONFLICT_COPY, OWNERSHIP_COPY } from "./prompt.js";
import { decideReconcile } from "./reconcile.js";
import { withRetry } from "./transport.js";
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isSaveRow(value, slot) {
    const v = value;
    return typeof v === "object" && v !== null && v.slot === slot && Number.isSafeInteger(v.schemaVersion)
        && Number.isSafeInteger(v.revision) && typeof v.payload === "object" && v.payload !== null && !Array.isArray(v.payload)
        && typeof v.updatedAt === "string";
}
function toCloudSave(row) {
    return { revision: row.revision, schemaVersion: row.schemaVersion, payload: row.payload, updatedAt: row.updatedAt };
}
function errorFor(result) {
    if (result.kind === "network")
        return { code: "network", message: result.message };
    const message = typeof result.body?.error === "string" ? String(result.body.error) : `HTTP ${result.status}`;
    return { code: result.status >= 500 ? "upstream" : "http", status: result.status, message };
}
export function createSavesClient(deps) {
    const { game, state, transport, prompt } = deps;
    const sleep = deps.sleep ?? defaultSleep;
    const debounceMs = deps.debounceMs ?? 750;
    const windowRef = deps.windowRef === undefined ? (typeof window === "undefined" ? null : window) : deps.windowRef;
    const lastPayload = new Map();
    const pending = new Map();
    const running = new Map();
    function assertSlot(slot) {
        if (!game.slots.includes(slot))
            throw new RangeError(`[account-kit] unknown save slot "${slot}" for ${game.gameSlug}`);
    }
    async function session() {
        const s = await deps.getSession();
        return s ? { token: s.access_token, userId: s.user.id } : null;
    }
    async function loadWith(slot, s) {
        const result = await withRetry(() => transport.load(slot, s.token), sleep);
        if (result.kind === "ok" && result.status === 200 && isSaveRow(result.body, slot)) {
            // Inbound cloud data is untrusted: a bad row (wrong shape, denylisted key, stale schema)
            // must not reach the game just because the server said 200.
            const valid = validatePayload(game.gameSlug, result.body.schemaVersion, slot, result.body.payload);
            if (!valid.ok) {
                console.warn(`[account-kit] rejecting cloud row for ${slot}: ${valid.detail}`);
                return { status: "error", error: { code: "invalid_payload", message: valid.detail } };
            }
            return { status: "ok", save: toCloudSave(result.body) };
        }
        if (result.kind === "ok" && result.status === 404)
            return { status: "none" };
        return { status: "error", error: errorFor(result) };
    }
    async function sendOnce(slot, payload, baseRevision, s) {
        const body = { schemaVersion: game.schemaVersion, baseRevision, payload, deviceId: state.deviceId(), idempotencyKey: crypto.randomUUID() };
        const result = await withRetry(() => transport.store(slot, body, s.token), sleep);
        if (result.kind === "ok" && result.status === 200) {
            const ok = result.body;
            if (Number.isSafeInteger(ok?.revision) && typeof ok.updatedAt === "string")
                return { kind: "stored", revision: ok.revision, updatedAt: ok.updatedAt };
            return { kind: "error", error: { code: "http", status: 200, message: "malformed reply" }, dirty: true };
        }
        if (result.kind === "ok" && result.status === 409) {
            const cloud = result.body?.cloud;
            if (!Number.isSafeInteger(cloud?.revision)) {
                // A 409 that doesn't tell us the cloud revision can't be resolved by prompting (there's
                // nothing to prompt with) or by looping — treat it as terminal instead of guessing 0.
                return { kind: "error", error: { code: "http", status: 409, message: "malformed conflict" }, dirty: true };
            }
            return { kind: "conflict", cloudRevision: cloud.revision };
        }
        const error = errorFor(result);
        const dirty = result.kind === "network" || result.status >= 500 || result.status === 429 || result.status === 401;
        return { kind: "error", error, dirty };
    }
    function confirmed(slot, s, revision) {
        state.writeRecord(s.userId, slot, { revision, dirty: false });
        state.writeOwner(slot, s.userId);
    }
    /** Send, and on 409 run the conflict prompt until the player's choice lands. */
    async function sendWithConflicts(slot, payload, baseRevision, s) {
        let base = baseRevision;
        for (;;) {
            const outcome = await sendOnce(slot, payload, base, s);
            if (outcome.kind === "stored") {
                confirmed(slot, s, outcome.revision);
                return { status: "stored", revision: outcome.revision, updatedAt: outcome.updatedAt };
            }
            if (outcome.kind === "error") {
                if (outcome.dirty)
                    state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
                return { status: "error", error: outcome.error };
            }
            state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
            const answer = await prompt.ask(CONFLICT_COPY);
            if (answer === "primary") {
                const loaded = await loadWith(slot, s);
                if (loaded.status !== "ok")
                    return { status: "error", error: loaded.status === "error" ? loaded.error : { code: "http", status: 404, message: "cloud row vanished" } };
                confirmed(slot, s, loaded.save.revision);
                return { status: "use_cloud", save: loaded.save };
            }
            base = outcome.cloudRevision;
        }
    }
    function serialized(slot, work) {
        const previous = running.get(slot) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        running.set(slot, next);
        return next;
    }
    async function flush(slot, payload) {
        const s = await session();
        if (!s)
            return { status: "signed_out" };
        const base = state.readRecord(s.userId, slot)?.revision ?? 0;
        return sendWithConflicts(slot, payload, base, s);
    }
    function store(slot, payload) {
        assertSlot(slot);
        const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, payload);
        if (!valid.ok) {
            console.warn(`[account-kit] refusing to store ${slot}: ${valid.detail}`);
            return Promise.resolve({ status: "error", error: { code: "invalid_payload", message: valid.detail } });
        }
        lastPayload.set(slot, payload);
        return new Promise((settle) => {
            const existing = pending.get(slot);
            if (existing) {
                existing.payload = payload;
                existing.settle.push(settle);
                return;
            }
            const entry = { payload, settle: [settle], timer: setTimeout(() => {
                    pending.delete(slot);
                    void serialized(slot, () => flush(slot, entry.payload))
                        .then((result) => entry.settle.forEach((fn) => fn(result)))
                        .catch((thrown) => {
                        const message = thrown instanceof Error ? thrown.message : String(thrown);
                        console.warn(`[account-kit] store flush for ${slot} failed: ${message}`);
                        entry.settle.forEach((fn) => fn({ status: "error", error: { code: "http", message } }));
                    });
                }, debounceMs) };
            pending.set(slot, entry);
        });
    }
    function reconcile(slot, local) {
        assertSlot(slot);
        return serialized(slot, async () => {
            try {
                // The migration path can hand us anything the old client had lying around locally
                // (denylisted keys included) — validate before it ever reaches a request.
                if (local !== null) {
                    const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, local);
                    if (!valid.ok) {
                        console.warn(`[account-kit] refusing to reconcile ${slot}: ${valid.detail}`);
                        return { status: "error", error: { code: "invalid_payload", message: valid.detail } };
                    }
                }
                const s = await session();
                if (!s)
                    return { status: "signed_out" };
                const loaded = await loadWith(slot, s);
                if (loaded.status === "error")
                    return loaded;
                const cloud = loaded.status === "ok" ? loaded.save : null;
                const decision = decideReconcile({ signedIn: true, cloud, local, record: state.readRecord(s.userId, slot), owner: state.readOwner(slot), userId: s.userId });
                const asReconcile = (result) => result.status === "stored" ? { status: "stored", revision: result.revision } : result;
                const upload = async () => {
                    const result = await sendWithConflicts(slot, local, 0, s);
                    return result.status === "stored" ? { status: "uploaded", revision: result.revision } : result;
                };
                switch (decision) {
                    case "signed_out": return { status: "signed_out" };
                    case "nothing": return { status: "nothing" };
                    case "upload": return upload();
                    case "ownership_prompt": {
                        if ((await prompt.ask(OWNERSHIP_COPY)) === "primary")
                            return upload();
                        state.writeOwner(slot, s.userId);
                        return { status: "fresh" };
                    }
                    case "use_cloud":
                        confirmed(slot, s, cloud.revision);
                        return { status: "use_cloud", save: cloud };
                    case "conflict_prompt": {
                        // The table already decided a prompt is due: never send first (a send on the cloud
                        // revision would silently win). Ask, then act on the answer.
                        const current = cloud;
                        state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
                        if ((await prompt.ask(CONFLICT_COPY)) === "primary") {
                            confirmed(slot, s, current.revision);
                            return { status: "use_cloud", save: current };
                        }
                        return asReconcile(await sendWithConflicts(slot, local, current.revision, s));
                    }
                    case "current": return { status: "current" };
                    case "restore_dirty":
                        return asReconcile(await sendWithConflicts(slot, local, state.readRecord(s.userId, slot)?.revision ?? 0, s));
                }
            }
            catch (thrown) {
                // reconcile() never rejects (same contract as load()/store()): a caller-supplied
                // getSession/transport/prompt that throws must still resolve to a reportable error.
                const message = thrown instanceof Error ? thrown.message : String(thrown);
                console.warn(`[account-kit] reconcile ${slot} failed: ${message}`);
                return { status: "error", error: { code: "http", message } };
            }
        });
    }
    /** Background re-flush of a dirty slot (online / visibilitychange): one attempt, no prompt.
     *  Prompting from here would resolve a conflict behind the player's back — see C1: a 409
     *  here just leaves the record dirty for the next foreground store()/reconcile() to resolve. */
    function quietFlush(slot, payload) {
        return serialized(slot, async () => {
            const s = await session();
            if (!s)
                return;
            const base = state.readRecord(s.userId, slot)?.revision ?? 0;
            const outcome = await sendOnce(slot, payload, base, s);
            if (outcome.kind === "stored") {
                confirmed(slot, s, outcome.revision);
                return;
            }
            if (outcome.kind === "conflict")
                return; // never prompt; record is already dirty
            if (outcome.kind === "error" && outcome.dirty) {
                state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
            }
        }).catch((thrown) => {
            const message = thrown instanceof Error ? thrown.message : String(thrown);
            console.warn(`[account-kit] background re-flush for ${slot} failed: ${message}`);
        });
    }
    async function reflushDirty() {
        const s = await session();
        if (!s)
            return;
        for (const [slot, payload] of lastPayload) {
            if (state.readRecord(s.userId, slot)?.dirty)
                void quietFlush(slot, payload);
        }
    }
    const onOnline = () => { void reflushDirty(); };
    const onVisibility = () => { if (windowRef?.document.visibilityState === "visible")
        void reflushDirty(); };
    windowRef?.addEventListener("online", onOnline);
    windowRef?.document.addEventListener("visibilitychange", onVisibility);
    function load(slot) {
        assertSlot(slot);
        return (async () => {
            try {
                const s = await session();
                return s ? await loadWith(slot, s) : { status: "signed_out" };
            }
            catch (thrown) {
                // load() never rejects: a caller-supplied getSession/transport that throws must still
                // resolve to a reportable error (same contract as store()/reconcile()).
                const message = thrown instanceof Error ? thrown.message : String(thrown);
                console.warn(`[account-kit] load ${slot} failed: ${message}`);
                return { status: "error", error: { code: "http", message } };
            }
        })();
    }
    return {
        game,
        load,
        store,
        reconcile,
        dispose() {
            // Close any open prompt / reject its pending ask FIRST: a conflict/ownership prompt
            // in flight inside sendWithConflicts()/reconcile() surfaces through their own catch as
            // { status: "error", error: { code: "http", message: "disposed" } } once this rejects.
            prompt.dispose();
            windowRef?.removeEventListener("online", onOnline);
            windowRef?.document.removeEventListener("visibilitychange", onVisibility);
            for (const entry of pending.values()) {
                clearTimeout(entry.timer);
                entry.settle.forEach((fn) => fn({ status: "error", error: { code: "http", message: "disposed" } }));
            }
            pending.clear();
        },
    };
}
