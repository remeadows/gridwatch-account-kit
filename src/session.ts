import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./client";
import { NEXUS_ORIGIN } from "./config";
import { validateHandle } from "./handle";
import { signInUrl } from "./returnPath";

export type Provider = "google" | "github";
export interface SignInOptions { redirectTo?: string }
export interface Profile { handle: string | null }
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

export function createAccountKit(input: AccountKitConfig): AccountKit {
  const config = { returnPath: input.returnPath, nexusOrigin: input.nexusOrigin ?? NEXUS_ORIGIN };
  const defaultRedirect = () => signInUrl(config.returnPath, config.nexusOrigin);

  async function currentUserId(): Promise<string | null> {
    const { data } = await getSupabase().auth.getSession();
    return data.session?.user.id ?? null;
  }

  return {
    config,
    // Contract: getSession() never rejects. Any failure (auth error or thrown network error) is
    // logged and reported as "no session", so callers can always settle their loading state.
    async getSession() {
      try {
        const { data, error } = await getSupabase().auth.getSession();
        if (error) console.warn("[account-kit] getSession failed:", error.message);
        return data.session;
      } catch (thrown) {
        console.warn("[account-kit] getSession threw:", thrown instanceof Error ? thrown.message : String(thrown));
        return null;
      }
    },
    onChange(callback) {
      const { data } = getSupabase().auth.onAuthStateChange((_event, session) => callback(session));
      return () => data.subscription.unsubscribe();
    },
    async signInWithEmail(email, options) {
      const { error } = await getSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: options?.redirectTo ?? defaultRedirect() },
      });
      return error ? error.message : null;
    },
    async signInWithProvider(provider, options) {
      const { error } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: { redirectTo: options?.redirectTo ?? defaultRedirect() },
      });
      return error ? error.message : null;
    },
    async signOut() {
      await getSupabase().auth.signOut();
    },
    async getProfile() {
      const userId = await currentUserId();
      if (!userId) return { handle: null };
      const { data, error } = await getSupabase().from("profiles").select("handle").eq("user_id", userId).maybeSingle();
      if (error) console.warn("[account-kit] profile load failed:", error.message);
      return { handle: (data as { handle?: string } | null)?.handle ?? null };
    },
    async saveHandle(raw) {
      const userId = await currentUserId();
      if (!userId) return "Not signed in.";
      const trimmed = raw.trim();
      const invalid = validateHandle(trimmed);
      if (invalid) return invalid;
      const { error } = await getSupabase().from("profiles").upsert({ user_id: userId, handle: trimmed });
      if (error) return (error as { code?: string }).code === "23505" ? "That handle is taken." : error.message;
      return null;
    },
    signInUrl: defaultRedirect,
  };
}
