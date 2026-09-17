import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./client.js";
import { NEXUS_ORIGIN } from "./config.js";
import { validateHandle } from "./handle.js";
import { signInUrl } from "./returnPath.js";
import { createSavesClient } from "./saves/client.js";
import { createDomPromptHost } from "./saves/prompt.js";
import { createSaveStateStore } from "./saves/state.js";
import { createTransport } from "./saves/transport.js";
import type { SaveGameConfig, SavesClient } from "./saves/types.js";

export type Provider = "google" | "github";
export interface SignInOptions { redirectTo?: string }
export interface Profile { handle: string | null }
export interface AccountKitConfig {
  /** Where this app lives on the Nexus origin, e.g. "/" for Nexus, "/play/match/" for Match. */
  returnPath: string;
  nexusOrigin?: string;
  /** Spec §3.2 constants; enables kit.saves. */
  game?: SaveGameConfig;
}

/** True when `e` carries a string `code` field (e.g. a PostgrestError), narrowing its type. */
function hasCode(e: unknown): e is { code: string } {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string";
}

export interface AccountKit {
  readonly config: Readonly<{ returnPath: string; nexusOrigin: string }>;
  readonly saves: SavesClient | undefined;
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

  // Contract: getSession() never rejects. Any failure (auth error or thrown network error) is
  // logged and reported as "no session", so callers can always settle their loading state.
  // A returned error must never leak a session alongside it — treat error as authoritative.
  async function getSession() {
    try {
      const { data, error } = await getSupabase().auth.getSession();
      if (error) {
        console.warn("[account-kit] getSession failed:", error.message);
        return null;
      }
      return data.session;
    } catch (thrown) {
      console.warn("[account-kit] getSession threw:", thrown instanceof Error ? thrown.message : String(thrown));
      return null;
    }
  }

  async function currentUserId(): Promise<string | null> {
    return (await getSession())?.user.id ?? null;
  }

  const saves: SavesClient | undefined = input.game
    ? createSavesClient({
        game: input.game,
        getSession: async () => { const s = await getSession(); return s ? { access_token: s.access_token, user: { id: s.user.id } } : null; },
        state: createSaveStateStore(input.game.gameSlug),
        transport: createTransport(`${config.nexusOrigin}/api/saves/${input.game.routeAlias}`),
        prompt: createDomPromptHost(),
      })
    : undefined;

  return {
    config,
    saves,
    getSession,
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
      const { error } = await getSupabase().auth.signOut();
      if (error) throw new Error(error.message);
    },
    async getProfile() {
      const userId = await currentUserId();
      if (!userId) return { handle: null };
      const { data, error } = await getSupabase().from("profiles").select("handle").eq("user_id", userId).maybeSingle();
      if (error) {
        console.warn("[account-kit] profile load failed:", error.message);
        throw new Error(error.message);
      }
      return { handle: (data as { handle?: string } | null)?.handle ?? null };
    },
    async saveHandle(raw) {
      const userId = await currentUserId();
      if (!userId) return "Not signed in.";
      const trimmed = raw.trim();
      const invalid = validateHandle(trimmed);
      if (invalid) return invalid;
      const { error } = await getSupabase().from("profiles").upsert({ user_id: userId, handle: trimmed });
      if (error) return hasCode(error) && error.code === "23505" ? "That handle is taken." : error.message;
      return null;
    },
    signInUrl: defaultRedirect,
  };
}
