import type { Session } from "@supabase/supabase-js";
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
}
export interface AccountKit {
    readonly config: Required<AccountKitConfig>;
    getSession(): Promise<Session | null>;
    onChange(callback: (session: Session | null) => void): () => void;
    signInWithEmail(email: string, options?: SignInOptions): Promise<string | null>;
    signInWithProvider(provider: Provider, options?: SignInOptions): Promise<string | null>;
    signOut(): Promise<void>;
    getProfile(): Promise<Profile>;
    saveHandle(raw: string): Promise<string | null>;
    signInUrl(): string;
}
export declare function createAccountKit(input: AccountKitConfig): AccountKit;
