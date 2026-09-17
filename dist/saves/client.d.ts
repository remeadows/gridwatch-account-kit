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
}
export declare function createSavesClient(deps: SavesClientDeps): SavesClient;
