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
    refreshSession?: () => Promise<{
        access_token: string;
        user: {
            id: string;
        };
    } | null>;
    /** Called exactly once per operation whose 401 could NOT be recovered, with the id of the user
     *  the operation was running as, so the host can stop showing a session the server no longer
     *  accepts. A throw (or an async callback's rejection) is contained with one warning, like
     *  onBackgroundStored: this is a notification, not part of the operation. */
    onSessionRejected?: (userId: string) => void;
}
export declare function createSavesClient(deps: SavesClientDeps): SavesClient;
