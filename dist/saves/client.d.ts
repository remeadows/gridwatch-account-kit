import type { SavePayload } from "../saves-schema/wire.js";
import { type PromptHost } from "./prompt.js";
import type { SaveStateStore } from "./state.js";
import { type Transport } from "./transport.js";
import type { SaveGameConfig, SavesClient } from "./types.js";
export interface SavesClientDeps {
    game: SaveGameConfig;
    getSession: () => Promise<{
        access_token: string;
        user: {
            id: string;
        };
    } | null>;
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
    onBackgroundStored?: (slot: string, payload: SavePayload, revision: number) => void;
}
export declare function createSavesClient(deps: SavesClientDeps): SavesClient;
