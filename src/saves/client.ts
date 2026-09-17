import { validatePayload } from "../saves-schema/games.js";
import type { ConflictBody, SavePayload, SaveRow, StoreRequest } from "../saves-schema/wire.js";
import { CONFLICT_COPY, OWNERSHIP_COPY, type PromptHost } from "./prompt.js";
import { decideReconcile } from "./reconcile.js";
import type { SaveStateStore } from "./state.js";
import { withRetry, type Transport, type TransportResult } from "./transport.js";
import type { CloudSave, LoadResult, ReconcileResult, SaveError, SaveGameConfig, SavesClient, StoreResult } from "./types.js";

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

function isSaveRow(value: unknown): value is SaveRow {
  const v = value as SaveRow;
  return typeof v === "object" && v !== null && typeof v.slot === "string" && Number.isSafeInteger(v.schemaVersion)
    && Number.isSafeInteger(v.revision) && typeof v.payload === "object" && v.payload !== null && typeof v.updatedAt === "string";
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
  const pending = new Map<string, { payload: SavePayload; timer: ReturnType<typeof setTimeout>; settle: Array<(r: StoreResult) => void> }>();
  const running = new Map<string, Promise<unknown>>();

  function assertSlot(slot: string): void {
    if (!game.slots.includes(slot)) throw new RangeError(`[account-kit] unknown save slot "${slot}" for ${game.gameSlug}`);
  }

  async function session(): Promise<Session | null> {
    const s = await deps.getSession();
    return s ? { token: s.access_token, userId: s.user.id } : null;
  }

  async function loadWith(slot: string, s: Session): Promise<LoadResult> {
    const result = await withRetry(() => transport.load(slot, s.token), sleep);
    if (result.kind === "ok" && result.status === 200 && isSaveRow(result.body)) return { status: "ok", save: toCloudSave(result.body) };
    if (result.kind === "ok" && result.status === 404) return { status: "none" };
    return { status: "error", error: errorFor(result) };
  }

  async function sendOnce(slot: string, payload: SavePayload, baseRevision: number, s: Session): Promise<SendOutcome> {
    const body: StoreRequest = { schemaVersion: game.schemaVersion, baseRevision, payload, deviceId: state.deviceId(), idempotencyKey: crypto.randomUUID() };
    const result = await withRetry(() => transport.store(slot, body, s.token), sleep);
    if (result.kind === "ok" && result.status === 200) {
      const ok = result.body as { revision?: unknown; updatedAt?: unknown };
      if (Number.isSafeInteger(ok?.revision) && typeof ok.updatedAt === "string") return { kind: "stored", revision: ok.revision as number, updatedAt: ok.updatedAt };
      return { kind: "error", error: { code: "http", status: 200, message: "malformed reply" }, dirty: true };
    }
    if (result.kind === "ok" && result.status === 409) {
      const cloud = (result.body as ConflictBody)?.cloud;
      return { kind: "conflict", cloudRevision: Number.isSafeInteger(cloud?.revision) ? cloud.revision : 0 };
    }
    const error = errorFor(result);
    const dirty = result.kind === "network" || result.status >= 500 || result.status === 429 || result.status === 401;
    return { kind: "error", error, dirty };
  }

  function confirmed(slot: string, s: Session, revision: number): void {
    state.writeRecord(s.userId, slot, { revision, dirty: false });
    state.writeOwner(slot, s.userId);
  }

  /** Send, and on 409 run the conflict prompt until the player's choice lands. */
  async function sendWithConflicts(slot: string, payload: SavePayload, baseRevision: number, s: Session): Promise<StoreResult> {
    let base = baseRevision;
    for (;;) {
      const outcome = await sendOnce(slot, payload, base, s);
      if (outcome.kind === "stored") { confirmed(slot, s, outcome.revision); return { status: "stored", revision: outcome.revision, updatedAt: outcome.updatedAt }; }
      if (outcome.kind === "error") {
        if (outcome.dirty) state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
        return { status: "error", error: outcome.error };
      }
      state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
      const answer = await prompt.ask(CONFLICT_COPY);
      if (answer === "primary") {
        const loaded = await loadWith(slot, s);
        if (loaded.status !== "ok") return { status: "error", error: loaded.status === "error" ? loaded.error : { code: "http", status: 404, message: "cloud row vanished" } };
        confirmed(slot, s, loaded.save.revision);
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

  async function flush(slot: string, payload: SavePayload): Promise<StoreResult> {
    const s = await session();
    if (!s) return { status: "signed_out" };
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
    lastPayload.set(slot, payload);
    return new Promise<StoreResult>((settle) => {
      const existing = pending.get(slot);
      if (existing) { existing.payload = payload; existing.settle.push(settle); return; }
      const entry = { payload, settle: [settle], timer: setTimeout(() => {
        pending.delete(slot);
        void serialized(slot, () => flush(slot, entry.payload))
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

  function reconcile(slot: string, local: SavePayload | null): Promise<ReconcileResult> {
    assertSlot(slot);
    return serialized(slot, async () => {
      const s = await session();
      if (!s) return { status: "signed_out" };
      const loaded = await loadWith(slot, s);
      if (loaded.status === "error") return loaded;
      const cloud = loaded.status === "ok" ? loaded.save : null;
      const decision = decideReconcile({ signedIn: true, cloud, local, record: state.readRecord(s.userId, slot), owner: state.readOwner(slot), userId: s.userId });
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
          if ((await prompt.ask(OWNERSHIP_COPY)) === "primary") return upload();
          state.writeOwner(slot, s.userId);
          return { status: "fresh" };
        }
        case "use_cloud": confirmed(slot, s, (cloud as CloudSave).revision); return { status: "use_cloud", save: cloud as CloudSave };
        case "conflict_prompt": {
          // The table already decided a prompt is due: never send first (a send on the cloud
          // revision would silently win). Ask, then act on the answer.
          const current = cloud as CloudSave;
          state.writeRecord(s.userId, slot, { revision: state.readRecord(s.userId, slot)?.revision ?? 0, dirty: true });
          if ((await prompt.ask(CONFLICT_COPY)) === "primary") {
            confirmed(slot, s, current.revision);
            return { status: "use_cloud", save: current };
          }
          return asReconcile(await sendWithConflicts(slot, local as SavePayload, current.revision, s));
        }
        case "current": return { status: "current" };
        case "restore_dirty":
          return asReconcile(await sendWithConflicts(slot, local as SavePayload, state.readRecord(s.userId, slot)?.revision ?? 0, s));
      }
    });
  }

  async function reflushDirty(): Promise<void> {
    const s = await session();
    if (!s) return;
    for (const [slot, payload] of lastPayload) {
      if (state.readRecord(s.userId, slot)?.dirty) void store(slot, payload);
    }
  }
  const onOnline = () => { void reflushDirty(); };
  const onVisibility = () => { if (windowRef?.document.visibilityState === "visible") void reflushDirty(); };
  windowRef?.addEventListener("online", onOnline);
  windowRef?.document.addEventListener("visibilitychange", onVisibility);

  function load(slot: string): Promise<LoadResult> {
    assertSlot(slot);
    return (async () => {
      const s = await session();
      return s ? loadWith(slot, s) : { status: "signed_out" };
    })();
  }

  return {
    game,
    load,
    store,
    reconcile,
    dispose() {
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
