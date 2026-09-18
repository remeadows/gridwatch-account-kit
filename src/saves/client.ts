import { validatePayload } from "../saves-schema/games.js";
import { MAX_BODY_BYTES } from "../saves-schema/wire.js";
import type { ConflictBody, SavePayload, SaveRow, StoreRequest } from "../saves-schema/wire.js";
import { CONFLICT_COPY, OWNERSHIP_COPY, type PromptHost } from "./prompt.js";
import { decideReconcile } from "./reconcile.js";
import type { SaveStateStore } from "./state.js";
import { withRetry, type Transport, type TransportResult } from "./transport.js";
import type { CloudSave, LoadResult, ReconcileOptions, ReconcileResult, SaveError, SaveGameConfig, SavesClient, StoreResult } from "./types.js";
import { uuidV4 } from "./uuid.js";

export interface SavesClientDeps {
  game: SaveGameConfig;
  getSession: () => Promise<{ access_token: string; user: { id: string } } | null>;
  state: SaveStateStore;
  transport: Transport;
  prompt: PromptHost;
  sleep?: (ms: number) => Promise<void>;
  debounceMs?: number;
  windowRef?: Window | null;
}

type Session = { token: string; userId: string };
type SendOutcome =
  | { kind: "stored"; revision: number; updatedAt: string }
  | { kind: "conflict"; cloudRevision: number }
  | { kind: "error"; error: SaveError; dirty: boolean };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Terminal instead of infinite: a peer that keeps winning every round means the loop itself,
 *  not one more prompt, is the problem. */
const MAX_CONFLICT_PROMPTS = 5;

function disposedError(): SaveError {
  return { code: "http", message: "disposed" };
}

// lastPayload is keyed by user AND slot, never slot alone: a single SavesClient instance
// outlives a sign-out/sign-in (createAccountKit builds it once), so a slot-only key would let a
// background re-flush send one account's remembered payload into another account's cloud row.
const payloadKey = (userId: string, slot: string) => `${userId}:${slot}`;

function isSaveRow(value: unknown, slot: string): value is SaveRow {
  const v = value as SaveRow;
  return typeof v === "object" && v !== null && v.slot === slot && Number.isSafeInteger(v.schemaVersion)
    && Number.isSafeInteger(v.revision) && typeof v.payload === "object" && v.payload !== null && !Array.isArray(v.payload)
    && typeof v.updatedAt === "string";
}

function toCloudSave(row: SaveRow): CloudSave {
  return { revision: row.revision, schemaVersion: row.schemaVersion, payload: row.payload, updatedAt: row.updatedAt };
}

function errorFor(result: TransportResult): SaveError {
  if (result.kind === "network") return { code: "network", message: result.message };
  const message = typeof (result.body as { error?: unknown })?.error === "string" ? String((result.body as { error: string }).error) : `HTTP ${result.status}`;
  return { code: result.status >= 500 ? "upstream" : "http", status: result.status, message };
}

export function createSavesClient(deps: SavesClientDeps): SavesClient {
  const { game, state, transport, prompt } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const debounceMs = deps.debounceMs ?? 750;
  const windowRef = deps.windowRef === undefined ? (typeof window === "undefined" ? null : window) : deps.windowRef;

  const lastPayload = new Map<string, SavePayload>();
  const pending = new Map<string, { payload: SavePayload; forUser: string | null; timer: ReturnType<typeof setTimeout>; settle: Array<(r: StoreResult) => void> }>();
  const running = new Map<string, Promise<unknown>>();
  // Set by dispose(); checked at the start of every serialized callback and immediately after
  // each await of session()/withRetry/prompt.ask so in-flight work started before dispose()
  // can't finish touching state after the client has been torn down.
  let disposed = false;
  // The most recently observed real (non-null) userId. store() reads this synchronously to stamp
  // *which user's* commit a debounced entry is, since session() can't be awaited until the timer
  // fires. Never cleared on a null (signed-out) session: a commit made while signed out is still
  // attributed to the last known user, so a *different* sign-in before the timer fires drops it
  // rather than uploading it under the wrong account (see flush()'s forUser check below).
  let lastKnownUserId: string | null = null;

  function assertSlot(slot: string): void {
    if (!game.slots.includes(slot)) throw new RangeError(`[account-kit] unknown save slot "${slot}" for ${game.gameSlug}`);
  }

  async function session(): Promise<Session | null> {
    const s = await deps.getSession();
    const next = s ? { token: s.access_token, userId: s.user.id } : null;
    if (next) lastKnownUserId = next.userId;
    return next;
  }

  async function loadWith(slot: string, s: Session): Promise<LoadResult> {
    const result = await withRetry(() => transport.load(slot, s.token), sleep);
    if (disposed) return { status: "error", error: disposedError() };
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
    if (result.kind === "ok" && result.status === 404) return { status: "none" };
    return { status: "error", error: errorFor(result) };
  }

  async function sendOnce(slot: string, payload: SavePayload, baseRevision: number, s: Session): Promise<SendOutcome> {
    const body: StoreRequest = { schemaVersion: game.schemaVersion, baseRevision, payload, deviceId: state.deviceId(), idempotencyKey: uuidV4() };
    const encodedBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (encodedBytes > MAX_BODY_BYTES) {
      return { kind: "error", error: { code: "invalid_payload", message: `request body exceeds ${MAX_BODY_BYTES} bytes` }, dirty: false };
    }
    const result = await withRetry(() => transport.store(slot, body, s.token), sleep);
    if (disposed) return { kind: "error", error: disposedError(), dirty: false };
    if (result.kind === "ok" && result.status === 200) {
      const ok = result.body as { revision?: unknown; updatedAt?: unknown };
      if (Number.isSafeInteger(ok?.revision) && typeof ok.updatedAt === "string") return { kind: "stored", revision: ok.revision as number, updatedAt: ok.updatedAt };
      return { kind: "error", error: { code: "http", status: 200, message: "malformed reply" }, dirty: true };
    }
    if (result.kind === "ok" && result.status === 409) {
      const cloud = (result.body as ConflictBody)?.cloud;
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

  function confirmed(slot: string, s: Session, revision: number): void {
    state.writeRecord(s.userId, slot, { revision, dirty: false });
    state.writeOwner(slot, s.userId);
  }

  /** Send, and on 409 run the conflict prompt until the player's choice lands. Bounded: a peer
   *  that keeps winning every round for MAX_CONFLICT_PROMPTS rounds ends the loop with a
   *  terminal error instead of prompting forever (the record is left dirty either way). */
  async function sendWithConflicts(slot: string, payload: SavePayload, baseRevision: number, s: Session): Promise<StoreResult> {
    let base = baseRevision;
    let conflictRounds = 0;
    for (;;) {
      const outcome = await sendOnce(slot, payload, base, s);
      if (outcome.kind === "stored") { confirmed(slot, s, outcome.revision); return { status: "stored", revision: outcome.revision, updatedAt: outcome.updatedAt }; }
      if (outcome.kind === "error") {
        if (outcome.dirty) state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
        return { status: "error", error: outcome.error };
      }
      state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
      if (conflictRounds >= MAX_CONFLICT_PROMPTS) {
        return { status: "error", error: { code: "http", status: 409, message: "conflict retries exhausted" } };
      }
      conflictRounds += 1;
      const answer = await prompt.ask(CONFLICT_COPY);
      if (disposed) return { status: "error", error: disposedError() };
      if (answer === "primary") {
        const loaded = await loadWith(slot, s);
        if (loaded.status !== "ok") return { status: "error", error: loaded.status === "error" ? loaded.error : { code: "http", status: 404, message: "cloud row vanished" } };
        confirmed(slot, s, loaded.save.revision);
        // The player chose "Use cloud": the local payload they were about to send is discarded,
        // so it must not be resurrected by a later background re-flush.
        lastPayload.delete(payloadKey(s.userId, slot));
        return { status: "use_cloud", save: loaded.save };
      }
      base = outcome.cloudRevision;
    }
  }

  function serialized<T>(slot: string, work: () => Promise<T>): Promise<T> {
    const previous = running.get(slot) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    running.set(slot, next);
    return next;
  }

  async function flush(slot: string, payload: SavePayload, forUser: string | null): Promise<StoreResult> {
    if (disposed) return { status: "error", error: disposedError() };
    const s = await session();
    if (disposed) return { status: "error", error: disposedError() };
    if (!s) return { status: "signed_out" };
    // A store() commit is bound to the user THIS CLIENT last observed signed in — forUser is
    // lastKnownUserId at the moment store() was called, captured before the debounce timer (and
    // thus before session() could be awaited) ever runs. That is not necessarily whoever is
    // signed in globally right now: lastKnownUserId is only primed by this client's own
    // session() calls, inside load()/reconcile()/flush() — not by a kit.getSession() call made
    // directly by the account bar or useAccount(), which this client never sees. Consequence: the
    // FIRST commit made after a sign-in this client hasn't yet observed for itself is compared
    // against the *previous* user and dropped here, resolving signed_out (with the warning
    // below); it self-heals on the very next commit, because this same flush's session() call
    // just observed the new user too — nothing is lost or mis-recorded, only that one commit
    // doesn't land. Calling reconcile() right after sign-in (as the usage example already does)
    // observes the new user immediately and avoids this case entirely. forUser is null only for
    // the very first store() this client ever makes before any session has resolved at all —
    // there is no prior user to compare against, so it proceeds under whoever is signed in at
    // flush time (today's behavior, unchanged for that one case).
    if (forUser !== null && s.userId !== forUser) {
      console.warn("[account-kit] dropped a store made by a different user");
      return { status: "signed_out" };
    }
    // store() can't know the signed-in user synchronously, so the payload is remembered here,
    // once the session is known, rather than at the top of store() (see payloadKey above).
    lastPayload.set(payloadKey(s.userId, slot), payload);
    const base = state.readRecord(s.userId, slot)?.revision ?? 0;
    return sendWithConflicts(slot, payload, base, s);
  }

  function store(slot: string, payload: SavePayload): Promise<StoreResult> {
    assertSlot(slot);
    const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, payload);
    if (!valid.ok) {
      console.warn(`[account-kit] refusing to store ${slot}: ${valid.detail}`);
      return Promise.resolve({ status: "error", error: { code: "invalid_payload", message: valid.detail } });
    }
    return new Promise<StoreResult>((settle) => {
      const existing = pending.get(slot);
      if (existing && existing.forUser === lastKnownUserId) {
        // Same observed owner as the pending entry: coalesce as usual, keeping the first caller's
        // forUser (a later call here never changes whose commit this is).
        existing.payload = payload;
        existing.settle.push(settle);
        return;
      }
      if (existing) {
        // A different user has been observed since the pending entry was created: it is not safe
        // to coalesce this payload into that entry (the wrong user's commit would ride along
        // either way). Drop the stale entry for its own waiters right now, the same way a
        // mismatched flush() would, and start a fresh entry for this call.
        clearTimeout(existing.timer);
        pending.delete(slot);
        console.warn("[account-kit] dropped a store made by a different user");
        existing.settle.forEach((fn) => fn({ status: "signed_out" }));
      }
      // Stamp the entry with whoever is (or was last) signed in right now — a later store() call
      // that coalesces into this same entry does not change whose commit this is.
      const forUser = lastKnownUserId;
      const entry = { payload, forUser, settle: [settle], timer: setTimeout(() => {
        pending.delete(slot);
        void serialized(slot, () => flush(slot, entry.payload, entry.forUser))
          .then((result) => entry.settle.forEach((fn) => fn(result)))
          .catch((thrown: unknown) => {
            const message = thrown instanceof Error ? thrown.message : String(thrown);
            console.warn(`[account-kit] store flush for ${slot} failed: ${message}`);
            entry.settle.forEach((fn) => fn({ status: "error", error: { code: "http", message } }));
          });
      }, debounceMs) };
      pending.set(slot, entry);
    });
  }

  function reconcile(slot: string, local: SavePayload | null, options?: ReconcileOptions): Promise<ReconcileResult> {
    assertSlot(slot);
    return serialized(slot, async () => {
      if (disposed) return { status: "error", error: disposedError() };
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
        if (disposed) return { status: "error", error: disposedError() };
        if (!s) return { status: "signed_out" };
        // The game may hold local edits without ever calling store() (signed out, or stores held
        // while offline), leaving a clean { revision, dirty: false } record that no longer matches
        // what's on screen. `localChanged` tells us so: mark the record dirty BEFORE the cloud
        // load runs, so decideReconcile prompts instead of silently handing back a newer cloud
        // row, and so a crash or a failed load still leaves the slot protected.
        let record = state.readRecord(s.userId, slot);
        if (options?.localChanged === true && local !== null && record !== null && !record.dirty) {
          record = { revision: record.revision, dirty: true };
          state.writeRecord(s.userId, slot, record);
          // a background re-flush of this slot must send the player's actual local payload, never an older one
          lastPayload.set(payloadKey(s.userId, slot), local);
        }
        const loaded = await loadWith(slot, s);
        if (loaded.status === "error") return loaded;
        const cloud = loaded.status === "ok" ? loaded.save : null;
        const decision = decideReconcile({ signedIn: true, cloud, local, record, owner: state.readOwner(slot), userId: s.userId });
        const asReconcile = (result: StoreResult): ReconcileResult =>
          result.status === "stored" ? { status: "stored", revision: result.revision } : result;
        const upload = async (): Promise<ReconcileResult> => {
          const result = await sendWithConflicts(slot, local as SavePayload, 0, s);
          return result.status === "stored" ? { status: "uploaded", revision: result.revision } : result;
        };
        switch (decision) {
          case "signed_out": return { status: "signed_out" };
          case "nothing": return { status: "nothing" };
          case "upload": return upload();
          case "ownership_prompt": {
            const answer = await prompt.ask(OWNERSHIP_COPY);
            if (disposed) return { status: "error", error: disposedError() };
            if (answer === "primary") return upload();
            state.writeOwner(slot, s.userId);
            // "Start fresh" always discards the local payload the player just rejected, no matter
            // why the record was dirty (a hinted reconcile seeding it above, or an unrelated
            // earlier failed store()): a background re-flush must never resurrect work the player
            // explicitly chose to abandon. Clear dirty on whatever record exists (there may be
            // none at all, if this slot was never synced) and drop any remembered payload.
            if (record !== null) state.writeRecord(s.userId, slot, { revision: record.revision, dirty: false });
            lastPayload.delete(payloadKey(s.userId, slot));
            return { status: "fresh" };
          }
          case "use_cloud":
            confirmed(slot, s, (cloud as CloudSave).revision);
            // The player had nothing local worth keeping, or the table already decided the cloud
            // row wins outright: either way there is no local payload left to protect.
            lastPayload.delete(payloadKey(s.userId, slot));
            return { status: "use_cloud", save: cloud as CloudSave };
          case "conflict_prompt": {
            // The table already decided a prompt is due: never send first (a send on the cloud
            // revision would silently win). Ask, then act on the answer.
            const current = cloud as CloudSave;
            state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
            const answer = await prompt.ask(CONFLICT_COPY);
            if (disposed) return { status: "error", error: disposedError() };
            if (answer === "primary") {
              confirmed(slot, s, current.revision);
              // The player chose "Use cloud": the local edits are discarded, so a background
              // re-flush must not later resurrect them.
              lastPayload.delete(payloadKey(s.userId, slot));
              return { status: "use_cloud", save: current };
            }
            return asReconcile(await sendWithConflicts(slot, local as SavePayload, current.revision, s));
          }
          case "current": return { status: "current" };
          case "restore_dirty":
            return asReconcile(await sendWithConflicts(slot, local as SavePayload, state.readRecord(s.userId, slot)?.revision ?? 0, s));
        }
      } catch (thrown) {
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
  function quietFlush(slot: string, payload: SavePayload, ownerUserId: string): Promise<void> {
    return serialized(slot, async () => {
      if (disposed) return;
      const s = await session();
      if (disposed) return;
      if (!s) return;
      // This quiet flush was queued for ownerUserId's dirty record and payload, but a foreground
      // operation (store()/reconcile()) — or simply other queued work — may have been running for
      // this slot when it was queued; by the time its turn in the serialized chain actually
      // comes up, the account may have switched (this client instance outlives sign-out/sign-in).
      // Re-check before touching anything: a different user's session must never see
      // ownerUserId's payload, record, or revision.
      if (s.userId !== ownerUserId) return;
      // A foreground conflict prompt (store()/reconcile()) may have been running when this quiet
      // flush was queued behind it; by the time it's our turn, the player may already have
      // resolved that conflict and cleared dirty. Re-read it now, inside the serialized callback,
      // instead of trusting the state from when reflushDirty() first queued us — otherwise this
      // still uploads the stale in-memory `payload` on top of the just-confirmed revision.
      if (!state.readRecord(s.userId, slot)?.dirty) return;
      const base = state.readRecord(s.userId, slot)?.revision ?? 0;
      const outcome = await sendOnce(slot, payload, base, s);
      if (disposed) return;
      if (outcome.kind === "stored") { confirmed(slot, s, outcome.revision); return; }
      if (outcome.kind === "conflict") return; // never prompt; record is already dirty
      if (outcome.kind === "error" && outcome.dirty) {
        state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
      }
    }).catch((thrown: unknown) => {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn(`[account-kit] background re-flush for ${slot} failed: ${message}`);
    });
  }

  async function reflushDirty(): Promise<void> {
    const s = await session();
    if (!s) return;
    // Invariant (this client instance outlives sign-out/sign-in, so this must hold everywhere a
    // payload can leave the client, not just here): a payload handed to the client by one
    // signed-in user is never sent under a different user's session — on the foreground debounce
    // path (flush()'s forUser check), when two store() calls coalesce (store()'s
    // existing.forUser check), on this background re-flush path, or via reconcile() (which
    // threads one session throughout and never crosses a debounce timer or a serialized queue it
    // didn't itself start). Every one of those checks is a *delayed* path: something is captured
    // now and used later, once other async work (a timer, a queued serialized callback, another
    // caller's operation) has had a chance to run — so each one re-reads who is actually signed
    // in at the moment it is about to act, rather than trusting who was signed in when the
    // payload/decision was captured. Here specifically, in two layers: looking up by
    // payloadKey(s.userId, slot) — rather than iterating lastPayload's own keys — means a payload
    // another account left behind is never even selected while a different user is signed in;
    // and quietFlush() re-checks its ownerUserId again once its turn in the slot's serialized
    // queue actually comes up, since it can be queued behind other work long enough for the
    // account to have switched again in the meantime.
    for (const slot of game.slots) {
      const payload = lastPayload.get(payloadKey(s.userId, slot));
      if (payload !== undefined && state.readRecord(s.userId, slot)?.dirty) void quietFlush(slot, payload, s.userId);
    }
  }
  const onOnline = () => { void reflushDirty(); };
  const onVisibility = () => { if (windowRef?.document.visibilityState === "visible") void reflushDirty(); };
  windowRef?.addEventListener("online", onOnline);
  windowRef?.document.addEventListener("visibilitychange", onVisibility);

  function load(slot: string): Promise<LoadResult> {
    assertSlot(slot);
    return (async () => {
      if (disposed) return { status: "error", error: disposedError() };
      try {
        const s = await session();
        if (disposed) return { status: "error", error: disposedError() };
        return s ? await loadWith(slot, s) : { status: "signed_out" };
      } catch (thrown) {
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
      disposed = true;
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
