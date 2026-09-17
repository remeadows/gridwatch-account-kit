export interface SyncRecord {
    revision: number;
    dirty: boolean;
}
export interface SaveStateStore {
    readRecord(userId: string, slot: string): SyncRecord | null;
    writeRecord(userId: string, slot: string, record: SyncRecord): void;
    readOwner(slot: string): string | null;
    writeOwner(slot: string, userId: string): void;
    deviceId(): string;
}
export declare function createSaveStateStore(gameSlug: string, storage?: Storage | null): SaveStateStore;
