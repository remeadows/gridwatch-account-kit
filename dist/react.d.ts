import type { Session } from "@supabase/supabase-js";
import type { AccountKit, Provider } from "./session";
/** Drop-in replacement for the apps' former useAuth(): same return shape. */
export declare function useAccount(kit: AccountKit): {
    session: Session | null;
    handle: string | null;
    loading: boolean;
    signInWithEmail: (email: string, redirectTo?: string) => Promise<string | null>;
    signInWithProvider: (provider: Provider, redirectTo?: string) => Promise<string | null>;
    saveHandle: (raw: string) => Promise<string | null>;
    signOut: () => Promise<void>;
};
