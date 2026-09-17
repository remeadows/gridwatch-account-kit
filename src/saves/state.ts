// Per-browser sync state (spec §5.4): one { revision, dirty } record per (user, game, slot),
// one ownership record per (game, slot), one device id per browser. Storage failures
// (private mode, quota) degrade to memory so the client keeps working for the session.
import { UUID_RE } from "../saves-schema/wire.js";
import { uuidV4 } from "./uuid.js";

export interface SyncRecord { revision: number; dirty: boolean }

export interface SaveStateStore {
  readRecord(userId: string, slot: string): SyncRecord | null;
  writeRecord(userId: string, slot: string, record: SyncRecord): void;
  readOwner(slot: string): string | null;
  writeOwner(slot: string, userId: string): void;
  deviceId(): string;
}

const DEVICE_KEY = "gw-account-kit.device-id.v1";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

function isSyncRecord(value: unknown): value is SyncRecord {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger((value as SyncRecord).revision) && (value as SyncRecord).revision >= 0
    && typeof (value as SyncRecord).dirty === "boolean";
}

export function createSaveStateStore(gameSlug: string, storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage): SaveStateStore {
  let backing: Storage = storage ?? memoryStorage();
  const fallback = memoryStorage();

  function read(key: string): string | null {
    try { return backing.getItem(key); } catch { backing = fallback; return fallback.getItem(key); }
  }
  function write(key: string, value: string): void {
    try { backing.setItem(key, value); } catch { backing = fallback; fallback.setItem(key, value); }
  }
  function readJson(key: string): unknown {
    const raw = read(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  const recordKey = (userId: string, slot: string) => `gw-account-kit.saves.${gameSlug}.${slot}.${userId}.v1`;
  const ownerKey = (slot: string) => `gw-account-kit.saves.${gameSlug}.${slot}.owner.v1`;

  return {
    readRecord(userId, slot) {
      const value = readJson(recordKey(userId, slot));
      return isSyncRecord(value) ? { revision: value.revision, dirty: value.dirty } : null;
    },
    writeRecord(userId, slot, record) {
      write(recordKey(userId, slot), JSON.stringify({ revision: record.revision, dirty: record.dirty }));
    },
    readOwner(slot) {
      const value = readJson(ownerKey(slot)) as { userId?: unknown } | null;
      return value && typeof value.userId === "string" && value.userId.length > 0 ? value.userId : null;
    },
    writeOwner(slot, userId) {
      write(ownerKey(slot), JSON.stringify({ userId }));
    },
    deviceId() {
      const existing = read(DEVICE_KEY);
      if (existing && UUID_RE.test(existing)) return existing;
      const created = uuidV4();
      write(DEVICE_KEY, created);
      return created;
    },
  };
}
