// Per-browser sync state (spec §5.4): one { revision, dirty } record per (user, game, slot),
// one ownership record per (game, slot), one device id per browser. Storage failures
// (private mode, quota) degrade to memory so the client keeps working for the session.
import { UUID_RE } from "../saves-schema/wire.js";
import { uuidV4 } from "./uuid.js";
const DEVICE_KEY = "gw-account-kit.device-id.v1";
function memoryStorage() {
    const map = new Map();
    return {
        get length() { return map.size; },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => { map.delete(k); },
        setItem: (k, v) => { map.set(k, String(v)); },
    };
}
function isSyncRecord(value) {
    return typeof value === "object" && value !== null
        && Number.isSafeInteger(value.revision) && value.revision >= 0
        && typeof value.dirty === "boolean";
}
export function createSaveStateStore(gameSlug, storage = typeof localStorage === "undefined" ? null : localStorage) {
    let backing = storage ?? memoryStorage();
    const fallback = memoryStorage();
    function read(key) {
        try {
            return backing.getItem(key);
        }
        catch {
            backing = fallback;
            return fallback.getItem(key);
        }
    }
    function write(key, value) {
        try {
            backing.setItem(key, value);
        }
        catch {
            backing = fallback;
            fallback.setItem(key, value);
        }
    }
    function remove(key) {
        try {
            backing.removeItem(key);
        }
        catch {
            backing = fallback;
            fallback.removeItem(key);
        }
    }
    function readJson(key) {
        const raw = read(key);
        if (raw === null)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    const recordKey = (userId, slot) => `gw-account-kit.saves.${gameSlug}.${slot}.${userId}.v1`;
    const ownerKey = (slot) => `gw-account-kit.saves.${gameSlug}.${slot}.owner.v1`;
    function readRecord(userId, slot) {
        const value = readJson(recordKey(userId, slot));
        return isSyncRecord(value) ? { revision: value.revision, dirty: value.dirty } : null;
    }
    return {
        readRecord,
        // A record's revision NEVER decreases. Every tab of the origin shares this record, and a writer
        // can be holding an older view than what is stored now (a cloud GET that started before another
        // tab confirmed a newer revision, or a record captured before an await). So the stored record
        // is re-read here, at write time, and a lower revision is refused — one rule for every writer:
        //   - a lower CLEAN write is a stale confirmation: it is dropped, and the stored record (dirty
        //     flag included) stands — an older confirmation says nothing about the newer revision;
        //   - a lower DIRTY write still marks the stored record dirty at its own revision: a local
        //     change is a local change whatever revision the writer thought it was based on, and
        //     dropping it would let the slot look synced while unsynced progress sits on screen.
        // Equal or higher revisions are written exactly as given.
        writeRecord(userId, slot, record) {
            const stored = readRecord(userId, slot);
            let next = { revision: record.revision, dirty: record.dirty };
            if (stored !== null && record.revision < stored.revision) {
                if (!record.dirty)
                    return;
                next = { revision: stored.revision, dirty: true };
            }
            write(recordKey(userId, slot), JSON.stringify(next));
        },
        clearRecord(userId, slot) {
            remove(recordKey(userId, slot));
        },
        readOwner(slot) {
            const value = readJson(ownerKey(slot));
            return value && typeof value.userId === "string" && value.userId.length > 0 ? value.userId : null;
        },
        writeOwner(slot, userId) {
            write(ownerKey(slot), JSON.stringify({ userId }));
        },
        deviceId() {
            const existing = read(DEVICE_KEY);
            if (existing && UUID_RE.test(existing))
                return existing;
            const created = uuidV4();
            write(DEVICE_KEY, created);
            return created;
        },
    };
}
