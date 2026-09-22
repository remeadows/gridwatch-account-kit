export interface SyncRecord {
    revision: number;
    dirty: boolean;
}
export interface SaveStateStore {
    readRecord(userId: string, slot: string): SyncRecord | null;
    writeRecord(userId: string, slot: string, record: SyncRecord): void;
    /** Forget this user's record for the slot ("never synced"). The one way a revision can go down:
     *  only for a cloud row that went backwards on the SERVER (see the saves client). */
    clearRecord(userId: string, slot: string): void;
    readOwner(slot: string): string | null;
    writeOwner(slot: string, userId: string): void;
    deviceId(): string;
}
export declare function createSaveStateStore(gameSlug: string, storage?: Storage | null): SaveStateStore;
