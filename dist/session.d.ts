import type { Session } from "@supabase/supabase-js";
import { type SavesClientDeps } from "./saves/client.js";
import type { SaveGameConfig, SavesClient } from "./saves/types.js";
export type Provider = "google" | "github";
export interface SignInOptions {
    redirectTo?: string;
}
export interface Profile {
    handle: string | null;
}
export interface AccountKitConfig {
    /** Where this app lives on the Nexus origin, e.g. "/" for Nexus, "/play/match/" for Match. */
    returnPath: string;
    nexusOrigin?: string;
    /** Spec §3.2 constants; enables kit.saves. */
    game?: SaveGameConfig;
    /** Optional hook on the saves client, passed straight through (ignored without `game`): fires
     *  after a background re-flush stored a slot, for games that keep their own "unsynced" marker.
     *  Kept out of `game`, which is the registry-checked wire config, not a place for callbacks. */
    onBackgroundStored?: SavesClientDeps["onBackgroundStored"];
}
export interface AccountKit {
    readonly config: Readonly<{
        returnPath: string;
        nexusOrigin: string;
    }>;
    readonly saves: SavesClient | undefined;
    getSession(): Promise<Session | null>;
    onChange(callback: (session: Session | null) => void): () => void;
    signInWithEmail(email: string, options?: SignInOptions): Promise<string | null>;
    signInWithProvider(provider: Provider, options?: SignInOptions): Promise<string | null>;
    signOut(): Promise<void>;
    getProfile(): Promise<Profile>;
    /** Upserts the signed-in user's handle. Pass `expectedUserId` (the user the form was rendered
     *  for) and the write is refused — with an error string, nothing written — when a different
     *  account is signed in by the time it is submitted. */
    saveHandle(raw: string, expectedUserId?: string): Promise<string | null>;
    signInUrl(): string;
}
export declare function createAccountKit(input: AccountKitConfig): AccountKit;
