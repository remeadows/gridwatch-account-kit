export interface SyncRecord {
    revision: number;
    dirty: boolean;
}
export interface SaveStateStore {
    readRecord(userId: string, slot: string): SyncRecord | null;
    writeRecord(userId: string, slot: string, record: SyncRecord): void;
    /** Forget this user's record for the slot ("never synced"). The one way a revision can go down:
     *  only for a cloud row that went backwards on the SERVER (see the saves client). It never
     *  discards a dirty flag: a record that is dirty when this runs (re-read at write time) becomes
     *  { revision: 0, dirty: true } instead of being removed; a clean one is removed. */
    clearRecord(userId: string, slot: string): void;
    readOwner(slot: string): string | null;
    writeOwner(slot: string, userId: string): void;
    deviceId(): string;
}
export declare function createSaveStateStore(gameSlug: string, storage?: Storage | null): SaveStateStore;
