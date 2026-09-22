import { canonicalJson } from "../saves-schema/canonical.js";
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
  /** Called after a background re-flush (online / visibilitychange) stored a slot successfully,
   *  so a game that keeps its own "unsynced" marker can clear it — that flush has no caller to
   *  resolve. Only that path fires it: never a foreground store()/reconcile(), never a flush that
   *  conflicted, errored, was discarded, stopped at another account's claim, or raced dispose().
   *  A throw is contained with one warning. */
  /** `userId` is the account whose cloud row the payload landed in. A background send can outlast a
   *  sign-out or an account switch, so a game whose bookkeeping is not per-user must compare it to
   *  whoever is signed in now before acting on the notification. It reports that THIS payload
   *  landed, not that the slot is up to date — a newer store() may be queued behind it — so compare
   *  `payload` to the slot's current state before clearing any "unsynced" marker. */
  onBackgroundStored?: (slot: string, payload: SavePayload, revision: number, userId: string) => void;
  /** Asked to recover the session when a request answers 401 — the saves API validates every
   *  token against Supabase, so a session revoked elsewhere is rejected while this device's cached
   *  JWT is still unexpired. Same shape `getSession` returns. Called at most ONCE per operation,
   *  and its result is only used when it names the SAME user the operation captured; anything else
   *  (null, another account, a throw) ends the operation with its 401 result. Without it, a 401 is
   *  exactly today's error, plus the notification below. */
  refreshSession?: () => Promise<{ access_token: string; user: { id: string } } | null>;
  /** Called exactly once per operation whose 401 could NOT be recovered, with the id of the user
   *  the operation was running as, so the host can stop showing a session the server no longer
   *  accepts. A throw (or an async callback's rejection) is contained with one warning, like
   *  onBackgroundStored: this is a notification, not part of the operation. */
  onSessionRejected?: (userId: string) => void;
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

/** One warning, one result, wherever a commit is dropped because the cloud copy won for its slot:
 *  at the top of flush(), or at store() time when a new call replaces a now-stale pending entry. */
function discardedStore(): StoreResult {
  console.warn("[account-kit] dropped a store the player discarded");
  return { status: "error", error: { code: "http", message: "discarded" } };
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

/** True for anything with a callable `then`. Used only to contain a caller-supplied callback that
 *  turns out to be async: the declared return type is void, but a game can hand us an `async`
 *  function whose rejection would otherwise escape a synchronous try/catch. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";
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
  // Bumped every time the player DISCARDS this user's local copy of a slot ("Use cloud" at either
  // prompt, the table's outright use_cloud, or "Start fresh"). Any store/re-flush that was already
  // queued for that user+slot captured the older epoch and is dropped instead of sent: forgetting
  // lastPayload is not enough, because a queued flush carries its own payload and would read its
  // baseRevision from the record the discard just confirmed at the cloud revision — a PUT that
  // succeeds with no 409 and silently replaces the copy the player just chose. Keyed like
  // lastPayload (user AND slot), so one account's discard never drops another account's work.
  const discardEpoch = new Map<string, number>();
  const epochOf = (userId: string, slot: string) => discardEpoch.get(payloadKey(userId, slot)) ?? 0;
  // Keyed by SLOT alone, and bumped at every discard beside the per-user epoch. It exists for the
  // one commit the per-user epoch cannot cover: a store() made before this client has observed any
  // session at all has no user to key an epoch by (forUser === null), and that is the COMMON
  // startup shape — the game kicks off its first reconcile() and the player commits while that
  // reconcile's session lookup or cloud request is still in flight. Without this, that commit
  // skipped both the owner gate and the epoch gate and flushed on the revision the reconcile had
  // just confirmed, silently overwriting the cloud copy. Deliberately conservative: ANY user's
  // discard on the slot drops such an entry, since there is no owner to compare it against.
  const slotDiscardGen = new Map<string, number>();
  const slotGenOf = (slot: string) => slotDiscardGen.get(slot) ?? 0;
  const noteDiscard = (userId: string, slot: string) => {
    discardEpoch.set(payloadKey(userId, slot), epochOf(userId, slot) + 1);
    slotDiscardGen.set(slot, slotGenOf(slot) + 1);
  };

  // What a commit is stamped with when store() captures it: its owner (the last user this client
  // had observed, or null if it had observed none), plus that owner's discard epoch or — with no
  // owner to key one by — the slot's discard generation. Exactly one of the two is non-null.
  type DiscardStamp = { forUser: string | null; epoch: number | null; slotGen: number | null };
  type PendingEntry = DiscardStamp & { payload: SavePayload; timer: ReturnType<typeof setTimeout>; settle: Array<(r: StoreResult) => void> };
  const pending = new Map<string, PendingEntry>();
  /** True once a discard has landed for what this commit was stamped with, so it may neither flush
   *  nor absorb a new store() call. Judged purely from the captured stamp, so it is answerable
   *  without a session — which matters, because a commit the player's choice already invalidated
   *  must report that, not signed_out, even if its user signed out before the flush. */
  const staleByDiscard = (e: DiscardStamp, slot: string) =>
    e.forUser === null
      ? e.slotGen !== null && slotGenOf(slot) !== e.slotGen
      : e.epoch !== null && epochOf(e.forUser, slot) !== e.epoch;
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

  /** One operation (a load(), a store()'s flush, a reconcile(), a background quietFlush()) and
   *  everything it may spend on a rejected session: the session it is running under, the single
   *  refresh it is allowed, and the single notification it may emit.
   *
   *  `s` is replaced only by a successful recovery, and only ever by the SAME user's refreshed
   *  session, so every later request in the operation carries the new token instead of the revoked
   *  one while the user it sends as — the one it captured — cannot change. Everything else in the
   *  client keeps reading the user id off this session, which is why a recovery that named a
   *  different account is treated as no recovery at all. */
  type Op = { s: Session; refreshed: boolean; notified: boolean };
  const operation = (s: Session): Op => ({ s, refreshed: false, notified: false });

  const is401 = (result: TransportResult) => result.kind === "ok" && result.status === 401;

  /** Contained exactly like onBackgroundStored, and for the same reason: the host's reaction (the
   *  kit's own wiring ends the local session) must never turn a reported 401 into a thrown or
   *  rejected operation. At most once per operation. */
  function notifySessionRejected(op: Op): void {
    if (op.notified) return;
    op.notified = true;
    const warnCallback = (thrown: unknown) => {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn(`[account-kit] onSessionRejected threw: ${message}`);
    };
    try {
      const returned: unknown = deps.onSessionRejected?.(op.s.userId);
      // The declared type is void, but a host can pass an `async` function whose rejection would
      // escape this try/catch — same containment as onBackgroundStored, deliberately not awaited.
      if (isThenable(returned)) returned.then(undefined, warnCallback);
    } catch (thrown) {
      warnCallback(thrown);
    }
  }

  /** The one refresh this operation is allowed. Null for every way it can fail to produce a
   *  session this operation may use: no dep, a second 401, no session, a throw, or a DIFFERENT
   *  user — a recovery that signed somebody else in is not this operation's session, and sending
   *  under it would upload one account's payload into another's row. */
  async function recoverSession(op: Op): Promise<Session | null> {
    if (op.refreshed || !deps.refreshSession) return null;
    op.refreshed = true;
    let recovered: { access_token: string; user: { id: string } } | null;
    try {
      recovered = await deps.refreshSession();
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn(`[account-kit] refreshSession threw: ${message}`);
      return null;
    }
    if (!recovered || recovered.user.id !== op.s.userId) return null;
    return { token: recovered.access_token, userId: recovered.user.id };
  }

  /** Every request the client makes goes through here: the attempt (with its existing bounded
   *  retry), and, on 401 only, this operation's one-shot session recovery.
   *
   *  Where it sits, and why: INSIDE the operation, after the caller's own gates have run and
   *  before its result is mapped. Every operation that can send is already at the front of its
   *  slot's serialized chain (store()'s flush, reconcile(), quietFlush()), so the extra await
   *  below cannot let another operation for that slot interleave — which is exactly what makes the
   *  discard gates those callers ran still binding here: a discard is only ever raised by a
   *  reconcile decision or a prompt answer for this slot, i.e. from inside that same chain. The
   *  disposed check the transport await already carries is repeated after the refresh, so a
   *  dispose() during it ends the operation without a retry and without notifying anyone. And
   *  recovery never prompts, so the background path keeps its "no prompt" promise for free. */
  async function request(op: Op, attempt: (s: Session) => Promise<TransportResult>): Promise<TransportResult> {
    const result = await withRetry(() => attempt(op.s), sleep);
    if (disposed || !is401(result)) return result;
    const recovered = await recoverSession(op);
    if (disposed) return result;
    if (!recovered) {
      notifySessionRejected(op);
      return result;
    }
    op.s = recovered;
    const retry = await withRetry(() => attempt(op.s), sleep);
    // No recovery inside the retry: one refresh per operation, and a second 401 ends it.
    if (!disposed && is401(retry)) notifySessionRejected(op);
    return retry;
  }

  async function loadWith(slot: string, op: Op): Promise<LoadResult> {
    const result = await request(op, (s) => transport.load(slot, s.token));
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

  /** True when this user's sync record, re-read NOW, is ahead of `save`. The record is shared by
   *  every tab of the origin, and a GET can be older than a revision another tab has confirmed since
   *  it was sent: such a row describes the cloud as it WAS, and deciding on it would hand the game
   *  a stale payload as use_cloud (and, before v0.2.6, roll the record back to it). */
  const behindRecord = (userId: string, slot: string, save: CloudSave) =>
    (state.readRecord(userId, slot)?.revision ?? -1) > save.revision;

  /** Retryable by design (the transport class). Only for a one-off cross-tab race: another tab
   *  confirming a newer revision while loadNotBehindRecord's re-load was in flight, or during
   *  reconcile's session re-check just before current() and the decision — retrying resolves it. */
  const staleRowError = (): SaveError => ({ code: "network", message: "cloud row is older than a revision this browser already confirmed; try again" });

  /** Behind this user's record, re-read now: an older row, or no row at all while the record says
   *  this user has confirmed one (revision > 0). A record at revision 0 was never confirmed against
   *  any row (a store that failed before the first upload), so a 404 is exactly what it expects. */
  const behindRecordOrMissing = (userId: string, slot: string, loaded: LoadResult) =>
    loaded.status === "ok" ? behindRecord(userId, slot, loaded.save)
      : loaded.status === "none" && (state.readRecord(userId, slot)?.revision ?? 0) > 0;

  /** loadWith() for every path that is about to DECIDE on the cloud row (reconcile, and the
   *  conflict prompts' "Use cloud"). A row older than the record stored for this user when it
   *  arrives — or a 404 while a record exists — is re-loaded once, and the second answer tells the
   *  causes apart:
   *    - a cross-tab race: another tab's store reached the server before that tab confirmed, so
   *      the re-load (sent after the confirmation) sees the newer row and is decided on normally;
   *    - a race again during the re-load (the row is at or above the record as it was when the
   *      re-load was sent, but another tab has confirmed past it since): the retryable stale-row
   *      error, nothing written;
   *    - the SERVER went backwards (the re-load is below the record as it was when it was sent) (an operator reset or deleted the row): the re-load is still
   *      behind. The record no longer describes anything the server has, so it is discarded —
   *      this user's slot is "never synced" — and the caller decides on the second load with
   *      record = null. The decision table then prompts over any local payload (cloud row + local
   *      with no record) or uploads it when there is no row (nothing on the server to lose), and
   *      adopts the cloud row only when there is nothing local. Never a retryable error forever,
   *      never a silent overwrite, never a silent adopt over local progress. The owner record is
   *      not touched: whose local save this is did not change. */
  async function loadNotBehindRecord(slot: string, op: Op): Promise<LoadResult> {
    const { loaded, regressedFrom } = await loadCheckingRecord(slot, op);
    if (regressedFrom !== null && !resetRegressed(op.s.userId, slot, regressedFrom)) return { status: "error", error: staleRowError() };
    return loaded;
  }

  /** The reset for a server regression loadCheckingRecord found, applied separately so a caller
   *  that still has a check to make first (reconcile's session re-check before current()) can run
   *  it BEFORE anything is written. `r0` is the record revision the regression was judged against:
   *  if another tab has confirmed past it since, the server does have a newer row after all, so
   *  this is a race, not a regression — nothing is written, and false is returned (the caller
   *  resolves the retryable stale-row error). */
  function resetRegressed(userId: string, slot: string, r0: number): boolean {
    if ((state.readRecord(userId, slot)?.revision ?? 0) > r0) return false;
    console.warn(`[account-kit] cloud row for ${slot} is behind this browser's sync record on a re-load too; treating the slot as never synced`);
    state.clearRecord(userId, slot);
    return true;
  }

  /** loadNotBehindRecord's load and classification, WITHOUT the reset: a server regression is
   *  reported as `regressedFrom` (r0) for the caller to pass to resetRegressed. */
  async function loadCheckingRecord(slot: string, op: Op): Promise<{ loaded: LoadResult; regressedFrom: number | null }> {
    const first = await loadWith(slot, op);
    if (!behindRecordOrMissing(op.s.userId, slot, first)) return { loaded: first, regressedFrom: null };
    // Fix round 2 (C1): the re-load is judged against the record as it was just BEFORE it was sent
    // (r0), not as it is when it returns. Another tab can confirm again while this GET is in
    // flight; the row it returns is then correct as of when it was served, and merely looks
    // "behind" the newer record. Only a row below r0 — or no row while r0 > 0 — says the SERVER
    // went backwards. Anything else still behind the record now is a race: the retryable stale-row
    // error, writing nothing (no record, no owner, no remembered payload).
    const r0 = state.readRecord(op.s.userId, slot)?.revision ?? 0;
    const second = await loadWith(slot, op);
    const regressed = second.status === "ok" ? second.save.revision < r0 : second.status === "none" && r0 > 0;
    if (regressed) return { loaded: second, regressedFrom: r0 };
    if (behindRecordOrMissing(op.s.userId, slot, second)) return { loaded: { status: "error", error: staleRowError() }, regressedFrom: null };
    return { loaded: second, regressedFrom: null };
  }

  async function sendOnce(slot: string, payload: SavePayload, baseRevision: number, op: Op): Promise<SendOutcome> {
    const body: StoreRequest = { schemaVersion: game.schemaVersion, baseRevision, payload, deviceId: state.deviceId(), idempotencyKey: uuidV4() };
    const encodedBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (encodedBytes > MAX_BODY_BYTES) {
      return { kind: "error", error: { code: "invalid_payload", message: `request body exceeds ${MAX_BODY_BYTES} bytes` }, dirty: false };
    }
    // One body, one idempotency key, across this send's transport retries AND a 401 retry under a
    // recovered token: it is the same write, so the server must be able to recognise it as one.
    const result = await request(op, (s) => transport.store(slot, body, s.token));
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

  /** What a successful send writes — and the two records are NOT the same kind of thing.
   *
   *  The SYNC RECORD is per (user, slot) and describes that user's own cloud row. The request
   *  that just succeeded was this user's, so writing it is always truthful no matter what else
   *  happened on this browser in the meantime. It is written unconditionally.
   *
   *  The OWNER RECORD is per SLOT, shared by every tab and every account on this browser, and it
   *  answers a different question: whose progress the local save on this device is.
   *  decideReconcile TRUSTS it — with owner === this user, a record equal to the cloud revision
   *  answers `current` and the local save is handed back as this user's own. So it is only ever
   *  changed by a path that actually settled the ownership question inside this slot's serialized
   *  chain: `claim: true`, used by the reconcile decisions that are take-overs by design
   *  (`use_cloud`, both conflict-prompt answers, the ownership prompt's "Upload" and "Start
   *  fresh"). Every other successful send — a store()/flush() and a background quietFlush() —
   *  passes `claim: false` and writes the owner only while it is unset or already names this
   *  user. Those paths check (or checked) the owner BEFORE their transport call awaited, and in
   *  that window another tab can sign in as a different account and claim the slot; writing it
   *  back afterwards would leave the kit trusting THAT account's progress as this user's the
   *  next time they return to this device, and their next commit would upload it into their own
   *  cloud row. Leaving a newer claim alone costs nothing: the sync record is still recorded, and
   *  whose save this is goes back to being the foreground ownership prompt's question. */
  function confirmed(slot: string, s: Session, revision: number, opts: { claim: boolean }): void {
    state.writeRecord(s.userId, slot, { revision, dirty: false });
    if (opts.claim) {
      state.writeOwner(slot, s.userId);
      return;
    }
    const owner = state.readOwner(slot);
    if (owner === null || owner === s.userId) state.writeOwner(slot, s.userId);
  }

  /** Send, and on 409 run the conflict prompt until the player's choice lands. Bounded: a peer
   *  that keeps winning every round for MAX_CONFLICT_PROMPTS rounds ends the loop with a
   *  terminal error instead of prompting forever (the record is left dirty either way).
   *
   *  `claim` comes from the CALLER, because this function is shared: reconcile's upload /
   *  restore_dirty / keep-this-one paths are take-overs and claim the slot, while a store()
   *  flush must not overwrite another account's claim (see confirmed() above). It is threaded
   *  through both places a send here can confirm — the plain success and the conflict prompt's
   *  "Use cloud" — so one caller's intent covers every outcome of its own send.
   *
   *  The session is read off `op` at every use rather than captured once, so a 401 recovery inside
   *  one of these sends is what the next round's send and the "Use cloud" load also use. Its user
   *  id cannot change (see Op), so every state write below still names the operation's own user. */
  async function sendWithConflicts(slot: string, payload: SavePayload, baseRevision: number, op: Op, claim: boolean): Promise<StoreResult> {
    let base = baseRevision;
    let conflictRounds = 0;
    for (;;) {
      const outcome = await sendOnce(slot, payload, base, op);
      if (outcome.kind === "stored") { confirmed(slot, op.s, outcome.revision, { claim }); return { status: "stored", revision: outcome.revision, updatedAt: outcome.updatedAt }; }
      if (outcome.kind === "error") {
        if (outcome.dirty) state.writeRecord(op.s.userId, slot, { revision: state.readRecord(op.s.userId, slot)?.revision ?? 0, dirty: true });
        return { status: "error", error: outcome.error };
      }
      state.writeRecord(op.s.userId, slot, { revision: state.readRecord(op.s.userId, slot)?.revision ?? 0, dirty: true });
      if (conflictRounds >= MAX_CONFLICT_PROMPTS) {
        return { status: "error", error: { code: "http", status: 409, message: "conflict retries exhausted" } };
      }
      conflictRounds += 1;
      const answer = await prompt.ask(CONFLICT_COPY);
      if (disposed) return { status: "error", error: disposedError() };
      if (answer === "primary") {
        const loaded = await loadNotBehindRecord(slot, op);
        if (loaded.status !== "ok") return { status: "error", error: loaded.status === "error" ? loaded.error : { code: "http", status: 404, message: "cloud row vanished" } };
        confirmed(slot, op.s, loaded.save.revision, { claim });
        // The player chose "Use cloud": the local payload they were about to send is discarded,
        // so it must not be resurrected by a later background re-flush, and any store or
        // re-flush this user had already queued for the slot must be dropped rather than sent on
        // top of the revision we just confirmed. Bumping here cannot affect THIS operation: when
        // we were reached from a store()'s own flush, that flush already made its epoch check at
        // its top, before this call — so it still reports its legitimate use_cloud result.
        lastPayload.delete(payloadKey(op.s.userId, slot));
        noteDiscard(op.s.userId, slot);
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

  async function flush(slot: string, payload: SavePayload, forUser: string | null, epoch: number | null, slotGen: number | null): Promise<StoreResult> {
    if (disposed) return { status: "error", error: disposedError() };
    // Precedence, applied identically at every exit that can produce an outcome for a captured
    // commit: disposed > discarded > everything else. The stamp check needs no session, so it runs
    // before the session is even resolved — deps.getSession is caller-supplied and may reject (an
    // expired refresh token, a network hiccup), and a commit the player's choice already
    // invalidated must not be reported as a transient session failure the caller will retry. The
    // same reasoning covers the signed_out return below: the choice outranks the state of the
    // session, and signed_out is precisely the result the README says a caller may retry after the
    // next sign-in — which would resurrect the save the cloud copy replaced.
    const stamp: DiscardStamp = { forUser, epoch, slotGen };
    if (staleByDiscard(stamp, slot)) return discardedStore();
    const s = await session();
    if (disposed) return { status: "error", error: disposedError() };
    // Again after the await: a discard can land DURING it (the session lookup is asynchronous, and
    // a reconcile at the front of this slot's chain can resolve in that window).
    if (staleByDiscard(stamp, slot)) return discardedStore();
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
    // there is no prior user to compare against, so as far as OWNERSHIP goes it proceeds under
    // whoever is signed in at flush time (today's behavior, unchanged for that one case). The
    // discard rule has no such exception: the gates above have already answered for that commit,
    // through the slot's discard generation.
    if (forUser !== null && s.userId !== forUser) {
      console.warn("[account-kit] dropped a store made by a different user");
      return { status: "signed_out" };
    }
    // The same discard rule again, now against the session that actually resolved rather than the
    // captured owner. A stale commit never reaches these two lines — the gate above already
    // answered for it — so they are a backstop, kept deliberately: they are the ones that read
    // s.userId, and they guarantee that whatever else is inserted between here and the transport
    // call, nothing this commit was invalidated for can reach lastPayload, state or the network.
    if (epoch !== null && epochOf(s.userId, slot) !== epoch) return discardedStore();
    if (forUser === null && slotGen !== slotGenOf(slot)) return discardedStore();
    // store() can't know the signed-in user synchronously, so the payload is remembered here,
    // once the session is known, rather than at the top of store() (see payloadKey above).
    lastPayload.set(payloadKey(s.userId, slot), payload);
    const base = state.readRecord(s.userId, slot)?.revision ?? 0;
    // claim: false — a store is not an ownership decision. This flush made no owner check at all,
    // and its send can outlast an account switch in another tab, so it may only claim a slot that
    // is unset or already this user's (see confirmed()).
    // The operation starts here, after every gate above has answered: its one 401 recovery covers
    // this send and anything the conflict loop does afterwards.
    return sendWithConflicts(slot, payload, base, operation(s), false);
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
      if (existing && existing.forUser === lastKnownUserId && !staleByDiscard(existing, slot)) {
        // Same observed owner as the pending entry, and no discard has landed since it was
        // created: coalesce as usual, keeping the first caller's forUser, epoch and slotGen (a
        // later call here never changes whose commit this is, nor which discards it predates).
        existing.payload = payload;
        existing.settle.push(settle);
        return;
      }
      if (existing) {
        // The entry can no longer take this call, and cannot be left to flush either. Drop it for
        // its own waiters right now, telling them what the precedence says — the same order
        // flush() uses: `discarded` if a discard landed for the stamp it carries, whether or not
        // it has an owner; otherwise `signed_out`, because a different user has been observed.
        clearTimeout(existing.timer);
        pending.delete(slot);
        if (staleByDiscard(existing, slot)) {
          // A discard landed for what that entry was stamped with — whoever made it, and whoever
          // is signed in now. Same precedence as flush(): the player's choice is reported ahead of
          // any session or owner reason, because it is the one outcome that must never be retried,
          // while signed_out invites exactly that. THIS call is not affected: it was made after
          // the discard, so it gets a fresh entry below and proceeds normally, as the README
          // promises. One warning for the drop, not one per coalesced waiter.
          const dropped = discardedStore();
          existing.settle.forEach((fn) => fn(dropped));
        } else {
          // Not stale, so the only remaining reason is that a different user has been observed
          // since the entry was created: it is not safe to coalesce this payload into it (the
          // wrong user's commit would ride along either way), and its own flush would have said
          // signed_out too.
          console.warn("[account-kit] dropped a store made by a different user");
          existing.settle.forEach((fn) => fn({ status: "signed_out" }));
        }
      }
      // Stamp the entry with whoever is (or was last) signed in right now — a later store() call
      // that coalesces into this same entry does not change whose commit this is — and with that
      // user's current discard epoch, so a discard raised between now and the flush drops this
      // commit instead of overwriting the copy the player chose. With no observed user there is no
      // epoch to key by, so such an entry carries the slot's discard generation instead and is
      // dropped by any discard on the slot (see slotDiscardGen above).
      const forUser = lastKnownUserId;
      const epoch = forUser === null ? null : epochOf(forUser, slot);
      const slotGen = forUser === null ? slotGenOf(slot) : null;
      const entry: PendingEntry = { payload, forUser, epoch, slotGen, settle: [settle], timer: setTimeout(() => {
        pending.delete(slot);
        void serialized(slot, () => flush(slot, entry.payload, entry.forUser, entry.epoch, entry.slotGen))
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
    // What `current()` is later compared against is the payload AS IT WAS at this call, taken here,
    // synchronously, before the slot's queue or any request is awaited. A game that keeps one
    // mutable save object and returns it from current() hands us the same reference twice: compared
    // live, a payload mutated in place while the GET was pending would always look "unchanged" —
    // the exact window the option exists to close. Only computed when the option is used; a value
    // that cannot be canonicalized is reported where the comparison would have happened.
    let passedCanonical: { ok: true; json: string } | { ok: false; message: string } | null = null;
    if (options?.current !== undefined) {
      try {
        passedCanonical = { ok: true, json: canonicalJson(local) };
      } catch (thrown) {
        passedCanonical = { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
      }
    }
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
        const resolved = await session();
        if (disposed) return { status: "error", error: disposedError() };
        if (!resolved) return { status: "signed_out" };
        let s: Session = resolved; // re-assigned only to the SAME user's refreshed session, below
        // This call's operation, carrying the session every request below actually sends with —
        // which a 401 recovery may replace by the SAME user's refreshed one — and its one-shot
        // recovery budget. `s` is kept alongside it for the user id and the state writes keyed by
        // it, which a recovery can never change; the two are re-synchronised at the one place this
        // function itself re-resolves the session (the `current` re-read below).
        const op = operation(resolved);
        let record = state.readRecord(s.userId, slot);
        /** Everything the `localChanged` hint does, in one place, because `current` (below) has to
         *  do exactly the same thing when its re-read comes back different — the whole point of
         *  that option is that a moved local payload is indistinguishable from a caller-hinted one.
         *
         *  A background re-flush of this slot must send the player's actual local payload, never
         *  an older one — and never skip the slot for want of one. So this seeds on a hinted
         *  call independent of the record: if the record is already dirty (an earlier failed
         *  store() or reconcile() left it so), lastPayload is either unset, in which case the
         *  re-flush would skip this slot entirely, or holds an older payload from that earlier
         *  attempt, which is exactly the stale content this seed exists to replace.
         *
         *  But ONLY when the slot is this user's or unclaimed. On a shared device `local` can be
         *  the OTHER account's progress: the owner record names U2 while U1 is signed in, and the
         *  question of whose save this is belongs to decideReconcile's ownedByOther prompt, a few
         *  lines below. Caching it under U1's key before that prompt has been answered — or,
         *  before a failed cloud load returns and the prompt never runs at all — hands a
         *  later background re-flush U2's progress to upload into U1's cloud row, at U1's own
         *  base revision, with no conflict and no prompt. With another owner this seeds nothing.
         *  Anything already remembered for this user+slot is left alone: that is U1's own earlier
         *  payload, and quietFlush's owner guard keeps it from being sent while the slot is
         *  someone else's. */
        const noteLocalChanged = (payload: SavePayload): void => {
          const owner = state.readOwner(slot);
          if (owner === null || owner === s.userId) lastPayload.set(payloadKey(s.userId, slot), payload);
          // The dirty flag itself is only forced on a CLEAN record, and is safe regardless of the
          // owner: decideReconcile raises ownership_prompt on ownedByOther whether or not the
          // record is dirty, so marking it cannot turn a prompt into a silent upload.
          // Against the record as it is NOW, never the `record` captured before an await: another
          // tab may have confirmed a newer revision since (and the state layer would refuse to
          // lower it anyway — this keeps the intent explicit).
          const latest = state.readRecord(s.userId, slot);
          if (latest !== null && !latest.dirty) state.writeRecord(s.userId, slot, { revision: latest.revision, dirty: true });
          record = state.readRecord(s.userId, slot);
        };
        /** The mirror image, for a `current` that reports the local payload is GONE (below). Every
         *  piece of per-user state this client holds for a slot describes one thing — that slot's
         *  unsynced local save for this user — so when the game says there is no such save any
         *  more, none of it may survive to be uploaded later:
         *    - the remembered payload, whether this call's own hint seeded it moments ago or an
         *      earlier failed store() left it, is a snapshot of exactly what was disowned;
         *    - the discard epoch is bumped for the same reason the prompts' "Use cloud" bumps it:
         *      a store still inside its debounce window, or one whose flush is already queued
         *      behind this reconcile, carries its own copy of that payload and would otherwise
         *      flush it on top of whatever the cloud holds;
         *    - the dirty flag is what keeps the slot queued for a background re-flush at all, and
         *      with no payload left to protect it is simply false. The revision is kept (it still
         *      describes this user's cloud row), and a slot this user never synced keeps its null
         *      record rather than gaining a fabricated one.
         *  The OWNER record is deliberately untouched: whose progress the local save on this
         *  device is remains a question only the foreground's ownership prompt answers, and "the
         *  game has no local payload right now" is not an answer to it. */
        const noteLocalGone = (): void => {
          lastPayload.delete(payloadKey(s.userId, slot));
          noteDiscard(s.userId, slot);
          // Re-read rather than reuse `record`: it was captured before the awaited cloud load, and
          // another tab sharing this storage may have confirmed a newer revision since. Writing the
          // old one back would roll the record behind the cloud row.
          const latest = state.readRecord(s.userId, slot);
          if (latest !== null && latest.dirty) {
            record = { revision: latest.revision, dirty: false };
            state.writeRecord(s.userId, slot, record);
          } else {
            record = latest;
          }
        };
        // The game may hold local edits without ever calling store() (signed out, or stores held
        // while offline), leaving a clean { revision, dirty: false } record that no longer matches
        // what's on screen. `localChanged` tells us so: mark the record dirty BEFORE the cloud
        // load runs, so decideReconcile prompts instead of silently handing back a newer cloud
        // row, and so a crash or a failed load still leaves the slot protected.
        if (options?.localChanged === true && local !== null) noteLocalChanged(local);
        // A server regression's reset is deferred while a `current` re-read is still to come: its
        // session re-check (below) may end this call as signed_out, and then nothing — the record
        // and its dirty flag included — may have been touched (fix round 2, M2).
        const checked = await loadCheckingRecord(slot, op);
        const loaded = checked.loaded;
        if (loaded.status === "error") return loaded;
        let pendingReset = checked.regressedFrom;
        if (pendingReset !== null && options?.current === undefined) {
          if (!resetRegressed(s.userId, slot, pendingReset)) return { status: "error", error: staleRowError() };
          pendingReset = null;
        }
        const cloud = loaded.status === "ok" ? loaded.save : null;
        // The cloud GET above can take seconds, and the game's save for this slot can move inside
        // that window. Deciding on the payload the caller handed us before the GET would then let
        // an automatic use_cloud replace a change the game has already made — silent loss the game
        // cannot repair afterwards, because by then this call has confirmed the cloud revision.
        // `current` is the re-read, and it happens HERE: after the cloud row is known and with no
        // await between it and the decision, so nothing can move in between. Once per reconcile,
        // and only on a call that actually reaches a decision.
        if (options?.current !== undefined) {
          // The re-read looks at the game's live state, and this client outlives a sign-out and
          // sign-in: if the account changed while the GET above was pending, that state may now
          // be ANOTHER account's, while the decision and any send below still carry the session
          // captured for this one. Re-resolve it first and stop if it is no longer the same user
          // — before current() runs, so there is still no await between the re-read and the
          // decision. Nothing has been written for this call yet (the `localChanged` hint's
          // seed-and-dirty is this user's own and stays truthful).
          const now = await session();
          if (disposed) return { status: "error", error: disposedError() };
          if (!now || now.userId !== s.userId) return { status: "signed_out" };
          // Same user: carry the freshly resolved session forward, so a token that refreshed while
          // the GET was pending is what any send below uses. UNLESS this operation's own 401
          // recovery already replaced the token: getSession and refreshSession are independent
          // host callbacks, and a host whose getSession still reports the stale token would put the
          // one the server just rejected back in place, with the operation's single recovery
          // already spent. The recovered session is the newer fact, so it stays.
          if (op.refreshed) {
            s = op.s;
          } else {
            s = now;
            op.s = now;
          }
          // The row was checked against the record when it arrived, but this session lookup was
          // one more await: another tab may have confirmed a newer revision inside it. Checked
          // again here, before current() and with no await left before the decision, so the table
          // is never handed a record ahead of the row (no re-load: that would put an await between
          // this check and the decision again).
          if (pendingReset !== null && !resetRegressed(s.userId, slot, pendingReset)) return { status: "error", error: staleRowError() };
          if (cloud !== null && behindRecord(s.userId, slot, cloud)) return { status: "error", error: staleRowError() };
          let fresh: SavePayload | null | undefined;
          let reread = false;
          try {
            fresh = options.current();
            reread = true;
          } catch (thrown) {
            // Contained, not reported: a re-read the game could not answer is not a reason to fail
            // a reconcile, and the passed payload is still a truthful (if older) snapshot. One
            // warning, then today's behavior exactly.
            const message = thrown instanceof Error ? thrown.message : String(thrown);
            console.warn(`[account-kit] current() for ${slot} threw, deciding on the payload passed to reconcile: ${message}`);
            // "The payload passed to reconcile" is a live reference the game may have mutated in
            // place since the call. Run it through the same comparison against the call-time
            // snapshot, so that move is still noticed; an untouched payload compares equal and
            // gets today's behavior exactly.
            fresh = local;
          }
          // `undefined` means "no re-read": a contained throw above, or a caller that returned
          // nothing at all. It is deliberately NOT treated like `null`, which is the game telling
          // us this slot has no local save any more.
          if (fresh !== undefined) {
            let moved: boolean;
            try {
              // The kit's own canonical JSON (RFC 8785: recursively sorted keys, no whitespace),
              // so a re-read that merely rebuilt the object in a different key order is not a
              // move. It throws on a value it cannot canonicalize (a lone surrogate, a non-finite
              // number, a class instance) — an invalid fresh payload by definition, which resolves
              // the error below rather than being mistaken for "unchanged".
              if (passedCanonical === null || !passedCanonical.ok) throw new Error(passedCanonical?.message ?? "payload cannot be canonicalized");
              moved = canonicalJson(fresh) !== passedCanonical.json;
            } catch (thrown) {
              const message = thrown instanceof Error ? thrown.message : String(thrown);
              console.warn(`[account-kit] refusing to reconcile ${slot}: ${message}`);
              return { status: "error", error: { code: "invalid_payload", message } };
            }
            if (moved) {
              // Validated the same way the passed payload was at the top of this call: the fresh
              // value is about to be decided on and sent, so an invalid one must resolve the same
              // error an invalid `local` gives, not reach a request.
              if (fresh !== null) {
                const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, fresh);
                if (!valid.ok) {
                  console.warn(`[account-kit] refusing to reconcile ${slot}: ${valid.detail}`);
                  return { status: "error", error: { code: "invalid_payload", message: valid.detail } };
                }
              }
              // From here on the fresh value IS the local payload, for the decision, for whatever
              // gets sent, and for what a later background re-flush remembers. Either way the
              // record is settled before the decision below, and `record` itself is updated so the
              // decision reads what was just written, never the pre-call value.
              //
              // A payload: exactly the hint's seed-and-dirty, which is what turns every automatic
              // `use_cloud` row into a prompt or an upload (see the table in decideReconcile:
              // record.revision < cloud.revision with a dirty record is conflict_prompt, and a
              // null record already was).
              //
              // `null`: the opposite, and not merely "seed nothing" — whatever was already
              // remembered or queued for this user+slot has to go, or the very next online event
              // uploads the save the game just told us no longer exists. Neither reachable row
              // consults the record here (`local === null` answers `nothing` with no cloud row and
              // `use_cloud` with one, both regardless of dirty), so this settles state without
              // changing any decision.
              local = fresh;
              if (local !== null) noteLocalChanged(local);
              else noteLocalGone();
            } else if (fresh === null && reread) {
              // Nothing moved — the call passed null and the re-read confirms null — but the game
              // has now told us twice that this slot has no local save. A payload remembered from
              // an earlier failed store() is a snapshot of that disowned save: left in place, the
              // next background re-flush would upload it into a slot the game considers empty.
              // Only an actual re-read counts; the throw fallback above asserts nothing.
              noteLocalGone();
            } else if (fresh !== null && reread) {
              // Equal to the call-time snapshot — but `local` is a reference the game may have
              // mutated since, and a successful re-read is the authority on what the slot holds
              // NOW. Decide on and send the re-read itself, never a detached copy that only used to
              // match it. Validated like any payload about to reach a request (the check at the top
              // of this call saw `local` after the queue wait, not as it was when passed).
              const valid = validatePayload(game.gameSlug, game.schemaVersion, slot, fresh);
              if (!valid.ok) {
                console.warn(`[account-kit] refusing to reconcile ${slot}: ${valid.detail}`);
                return { status: "error", error: { code: "invalid_payload", message: valid.detail } };
              }
              local = fresh;
            }
          }
        }
        // The record as stored NOW (no await since the stale-row checks above, so never ahead of
        // `cloud`), not the one captured before the GET.
        record = state.readRecord(s.userId, slot);
        const decision = decideReconcile({ signedIn: true, cloud, local, record, owner: state.readOwner(slot), userId: s.userId });
        const asReconcile = (result: StoreResult): ReconcileResult =>
          result.status === "stored" ? { status: "stored", revision: result.revision } : result;
        const upload = async (): Promise<ReconcileResult> => {
          // claim: true — this is either the table's own `upload` (the slot is unset or already
          // this user's) or the ownership prompt's "Upload", which is a deliberate take-over.
          // Both are ownership decisions made here, at the front of this slot's chain.
          const result = await sendWithConflicts(slot, local as SavePayload, 0, op, true);
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
            // "Start fresh" claims the slot outright (the direct equivalent of confirmed()'s
            // claim: true): the player just told us the local save is no longer anyone else's
            // progress to protect, and the game is about to replace it with defaults.
            state.writeOwner(slot, s.userId);
            // "Start fresh" always discards the local payload the player just rejected, no matter
            // why the record was dirty (a hinted reconcile seeding it above, or an unrelated
            // earlier failed store()): a background re-flush must never resurrect work the player
            // explicitly chose to abandon. Clear dirty on whatever record exists (there may be
            // none at all, if this slot was never synced) and drop any remembered payload.
            if (record !== null) state.writeRecord(s.userId, slot, { revision: record.revision, dirty: false });
            lastPayload.delete(payloadKey(s.userId, slot));
            noteDiscard(s.userId, slot);
            return { status: "fresh" };
          }
          case "use_cloud":
            // claim: true — the local save on this device is being replaced by THIS user's cloud
            // row, so this user is now demonstrably whose progress it is. A take-over by design.
            confirmed(slot, s, (cloud as CloudSave).revision, { claim: true });
            // The player had nothing local worth keeping, or the table already decided the cloud
            // row wins outright: either way there is no local payload left to protect.
            lastPayload.delete(payloadKey(s.userId, slot));
            noteDiscard(s.userId, slot);
            return { status: "use_cloud", save: cloud as CloudSave };
          case "conflict_prompt": {
            // The table already decided a prompt is due: never send first (a send on the cloud
            // revision would silently win). Ask, then act on the answer.
            let current = cloud as CloudSave;
            state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
            const answer = await prompt.ask(CONFLICT_COPY);
            if (disposed) return { status: "error", error: disposedError() };
            if (answer === "primary") {
              // The prompt may have been open for a long time, and another tab may have confirmed
              // a newer revision meanwhile: "Use cloud" then means the cloud as it is NOW. Same
              // rule as the load above — re-load, and never hand back a row older than the record
              // (on a still-stale answer the record stays dirty and nothing is discarded).
              if (behindRecord(s.userId, slot, current)) {
                const reloaded = await loadNotBehindRecord(slot, op);
                if (reloaded.status === "error") return reloaded;
                if (reloaded.status !== "ok") return { status: "error", error: { code: "http", status: 404, message: "cloud row vanished" } };
                current = reloaded.save;
              }
              // claim: true — the player answered the ownership question just now, in this chain:
              // this device's local save becomes this user's cloud row.
              confirmed(slot, s, current.revision, { claim: true });
              // The player chose "Use cloud": the local edits are discarded, so a background
              // re-flush must not later resurrect them, and neither must a store this user had
              // already queued for the slot behind this reconcile.
              lastPayload.delete(payloadKey(s.userId, slot));
              noteDiscard(s.userId, slot);
              return { status: "use_cloud", save: current };
            }
            // claim: true — "Keep this one" is the take-over answer: the player said the local
            // save is theirs and it is going up as their cloud row.
            return asReconcile(await sendWithConflicts(slot, local as SavePayload, current.revision, op, true));
          }
          case "current": return { status: "current" };
          case "restore_dirty":
            // claim: true — the table only reaches restore_dirty when the slot is unset or already
            // this user's (decideReconcile sends ownedByOther to conflict_prompt instead), and it
            // is a reconcile decision made here, at the front of this slot's chain.
            return asReconcile(await sendWithConflicts(slot, local as SavePayload, state.readRecord(s.userId, slot)?.revision ?? 0, op, true));
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
  function quietFlush(slot: string, payload: SavePayload, ownerUserId: string, epoch: number): Promise<void> {
    return serialized(slot, async () => {
      if (disposed) return;
      // Same precedence as flush(), for the same reason and in the same position: the stamp this
      // re-flush was selected under needs no session, so it is checked before one is resolved.
      // This path has no caller to inform — the only question is whether it can SEND a payload the
      // player discarded — but keeping the order identical means a rejecting or slow getSession
      // cannot get between the discard and the check, and one rule covers both paths.
      if (epochOf(ownerUserId, slot) !== epoch) return;
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
      // The discard check again, now against the session that actually resolved: a discard can
      // land DURING the session lookup, and the player may have thrown away exactly the payload
      // selected for this re-flush. The dirty re-read below usually catches that too (a discard
      // confirms the record clean), but not if something marked the slot dirty again in between.
      if (epochOf(s.userId, slot) !== epoch) return;
      // Whose slot this is, is a question the foreground answers with a prompt (decideReconcile's
      // ownedByOther → ownership_prompt, "Start fresh" or take over). A background flush must
      // never answer it by uploading, so it stops here while the slot is recorded to another
      // account — defence in depth behind the seeding rule in reconcile()'s hint block: even if
      // something did cache a payload that is not this user's, it cannot leave the client this
      // way. A record left dirty by this simply stays dirty until a foreground reconcile settles
      // the ownership; nothing is lost, it only waits.
      const slotOwner = state.readOwner(slot);
      if (slotOwner !== null && slotOwner !== ownerUserId) return;
      // A foreground conflict prompt (store()/reconcile()) may have been running when this quiet
      // flush was queued behind it; by the time it's our turn, the player may already have
      // resolved that conflict and cleared dirty. Re-read it now, inside the serialized callback,
      // instead of trusting the state from when reflushDirty() first queued us — otherwise this
      // still uploads the stale in-memory `payload` on top of the just-confirmed revision.
      if (!state.readRecord(s.userId, slot)?.dirty) return;
      const base = state.readRecord(s.userId, slot)?.revision ?? 0;
      // A copy of what is actually sent: `payload` is the object the game handed store()/reconcile(),
      // which it may mutate while this request is in flight. onBackgroundStored must describe what
      // the cloud now holds, or a game comparing it to its current save could clear an "unsynced"
      // marker for content that was never stored.
      //
      // And it is what is remembered NOW, not what this closure captured when it was queued: a
      // foreground store()/reconcile() ahead of it in the chain may have remembered a newer payload
      // and then failed to send it, leaving the record dirty. Sending the captured one would land
      // stale content on the confirmed revision and mark the slot clean over the latest save.
      // Nothing remembered any more means it was disowned or sent: there is nothing to do.
      const latest = lastPayload.get(payloadKey(s.userId, slot));
      if (latest === undefined) return;
      const sent = JSON.parse(JSON.stringify(latest)) as SavePayload;
      // The operation starts here, after every guard above: a background re-flush gets the same
      // one-shot 401 recovery as a foreground send, and since recovery never prompts, this path's
      // "never prompt the player" promise is unaffected.
      const outcome = await sendOnce(slot, sent, base, operation(s));
      if (disposed) return;
      // claim: false — and this is the path the rule exists for. The owner check above ran BEFORE
      // sendOnce awaited; while the transport was pending, another tab could sign in as a
      // different account and claim the slot. Recording the revision for this user stays
      // truthful; re-asserting the ownership would silently overwrite that newer claim.
      if (outcome.kind === "stored") {
        confirmed(slot, s, outcome.revision, { claim: false });
        // After confirmed(), never before: the callback tells the game its payload IS the cloud
        // row now, so the kit's own record must already say so. Contained, because a game's
        // marker bookkeeping throwing must not turn a successful re-flush into the warning
        // quietFlush's own catch would log for a failed one, nor leave the slot looking unsynced.
        const warnCallback = (thrown: unknown) => {
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          console.warn(`[account-kit] onBackgroundStored for ${slot} threw: ${message}`);
        };
        try {
          const returned: unknown = deps.onBackgroundStored?.(slot, sent, outcome.revision, s.userId);
          // The declared type is void, but a game can pass an `async` function: its rejection
          // would escape the catch below and surface as an unhandled rejection in the host page.
          // Attach a handler so it reports through the same single warning instead. Deliberately
          // not awaited — a background re-flush does not wait on the game's bookkeeping — and
          // deliberately not done for `current`, which is documented synchronous and returns a
          // payload, never a promise.
          if (isThenable(returned)) returned.then(undefined, warnCallback);
        } catch (thrown) {
          warnCallback(thrown);
        }
        return;
      }
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
    // REMEMBERED payload can leave the client): a payload the client itself remembered —
    // debounced in store()'s pending entry, coalesced across store() calls, or held in
    // lastPayload for a background re-flush — is never sent under a different user's session
    // than the one that supplied it. That covers the foreground debounce path (flush()'s
    // forUser check), coalescing (store()'s existing.forUser check), and this background
    // re-flush path, in two layers: looking up by payloadKey(s.userId, slot) — rather than
    // iterating lastPayload's own keys — means a payload another account left behind is never
    // even selected while a different user is signed in; and quietFlush() re-checks its
    // ownerUserId again once its turn in the slot's serialized queue actually comes up, since it
    // can be queued behind other work long enough for the account to have switched again in the
    // meantime. Every one of those checks is a *delayed* path: something is captured now and
    // used later, once other async work (a timer, a queued serialized callback, another caller's
    // operation) has had a chance to run — so each one re-reads who is actually signed in at the
    // moment it is about to act, rather than trusting who was signed in when the payload was
    // captured.
    //
    // reconcile() is deliberately NOT part of this list: its `local` payload is supplied fresh
    // by the caller on every call, not remembered by the client, and reconcile() resolves its
    // session as late as possible — at the front of the slot's serialized queue — so it is sent
    // under whoever is signed in AT THAT POINT, which may not be who was signed in when the
    // caller made the call. That's the intended contract (it's why the usage example calls
    // reconcile() once the session is already known), and it's exactly the case the per-slot
    // ownership record and its take-over prompt ("fresh") exist to handle.
    //
    // One exception, and the reason it is narrow: a hinted reconcile DOES remember its `local`
    // payload, so that a re-flush of an already-dirty slot sends what the player actually has
    // rather than an older attempt. That seed is therefore restricted to a slot this user owns or
    // that nobody owns — on a shared device `local` can be the other account's progress, and
    // whose save it is belongs to the ownership prompt, not to a cache written before that prompt
    // has run (or before a failed cloud load returns and it never runs at all). quietFlush()
    // carries the matching guard: it stops while the slot is recorded to another account, so a
    // background path never settles an ownership question by uploading.
    //
    // Second invariant, on the same delayed paths and for the same reason (something captured now,
    // used after other async work has run): once the player DISCARDS a slot's local copy — the
    // table's outright use_cloud, "Use cloud" at either prompt, or "Start fresh" — nothing this
    // user had already queued for that slot may still be sent. Forgetting lastPayload is not
    // enough: a store whose debounce timer is still pending, and worse a store whose flush is
    // already queued in the slot's serialized chain behind the discard, each carry their own
    // payload and would read baseRevision from the record the discard just confirmed AT the cloud
    // revision — so the PUT succeeds with no 409 and quietly replaces the copy the player chose
    // with the one they threw away. Both cases are closed by one per-user+slot discardEpoch:
    // captured when a pending entry is created (store()) and when a payload is selected for a
    // re-flush (just below), re-checked at the moment of use (flush()'s epoch gate, before
    // lastPayload or any state/transport touch, resolving an error "discarded" for every waiter of
    // that entry; quietFlush()'s, which simply returns), and bumped at every discard next to the
    // lastPayload.delete that accompanies it (noteDiscard). It is per user for the same reason
    // lastPayload is: one account's discard must not drop another account's queued work for that
    // slot. Two consequences worth stating, because both were once wrong:
    //   - Unlike the owner invariant above, the discard rule has NO first-store exception. A
    //     commit made before this client observed any session has no user to key an epoch by, so
    //     it carries the slot's discard generation instead (slotDiscardGen) and any discard on the
    //     slot drops it — that is the ordinary startup race (a commit made while the game's first
    //     reconcile() is still in flight), not an exotic one. Only the OWNER check keeps its
    //     documented exemption for such a commit.
    //   - A store made AFTER a discard proceeds normally, which means it must not inherit a
    //     pre-discard entry: store() refuses to coalesce into an entry whose epoch (or slot
    //     generation, when it has no owner) has moved, dropping that entry for its own waiters and
    //     starting a fresh one stamped with the current values.
    //
    // Third invariant, and the one that separates the two kinds of local state: the per-slot
    // ownership record is taken over from another account only by a reconcile decision. A store or
    // a background re-flush claims it just while it is unset or already names that user, never
    // when it finishes after another account claimed the slot. The per-user sync
    // record has no such rule — it describes the row of the user whose request just succeeded, so
    // writing it is always truthful — but the owner record is shared by every tab and every
    // account on this browser and says whose progress the LOCAL save is, a question only the
    // foreground's ownership prompt (or an explicit use_cloud/conflict answer) can answer. Both
    // send paths check the owner, if at all, before their transport call awaits, and an account
    // switch in another tab inside that window is exactly the case: re-asserting the ownership on
    // success would overwrite the newer claim and leave the kit trusting the OTHER account's
    // progress as this user's the next time they come back to this device. See confirmed().
    for (const slot of game.slots) {
      const payload = lastPayload.get(payloadKey(s.userId, slot));
      if (payload !== undefined && state.readRecord(s.userId, slot)?.dirty) void quietFlush(slot, payload, s.userId, epochOf(s.userId, slot));
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
        return s ? await loadWith(slot, operation(s)) : { status: "signed_out" };
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
