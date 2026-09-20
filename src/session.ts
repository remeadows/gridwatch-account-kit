import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./client.js";
import { NEXUS_ORIGIN } from "./config.js";
import { validateHandle } from "./handle.js";
import { signInUrl } from "./returnPath.js";
import { payloadSchemas, resolveSaveGame } from "./saves-schema/games.js";
import { ALIAS_RE, SLOT_RE } from "./saves-schema/wire.js";
import { createSavesClient, type SavesClientDeps } from "./saves/client.js";
import { createDomPromptHost } from "./saves/prompt.js";
import { createSaveStateStore } from "./saves/state.js";
import { createTransport } from "./saves/transport.js";
import type { SaveGameConfig, SavesClient } from "./saves/types.js";

function gameConfigMismatch(what: string): TypeError {
  return new TypeError(`[account-kit] game config does not match the saves registry: ${what}`);
}

/** Fail fast when a game config was hand-typed wrong (transposed fields, a typo'd slot) instead
 *  of letting it silently 404/mismatch at runtime — the saves registry is the source of truth. */
function assertGameConfig(game: SaveGameConfig): void {
  if (!ALIAS_RE.test(game.routeAlias)) throw gameConfigMismatch(`invalid routeAlias "${game.routeAlias}"`);
  for (const slot of game.slots) {
    if (!SLOT_RE.test(slot)) throw gameConfigMismatch(`invalid slot "${slot}"`);
  }
  const registered = resolveSaveGame(game.routeAlias);
  if (!registered) throw gameConfigMismatch(`unknown routeAlias "${game.routeAlias}"`);
  if (registered.slug !== game.gameSlug) throw gameConfigMismatch(`gameSlug "${game.gameSlug}" does not match registry "${registered.slug}" for "${game.routeAlias}"`);
  const sameSlots = registered.slots.length === game.slots.length && registered.slots.every((slot) => game.slots.includes(slot));
  if (!sameSlots) throw gameConfigMismatch(`slots [${game.slots.join(", ")}] do not match registry [${registered.slots.join(", ")}] for "${game.routeAlias}"`);
  if (registered.schemaVersion !== game.schemaVersion) throw gameConfigMismatch(`schemaVersion ${game.schemaVersion} does not match registry ${registered.schemaVersion} for "${game.routeAlias}"`);
  const slotSchemas = payloadSchemas[game.gameSlug]?.[game.schemaVersion];
  for (const slot of game.slots) {
    if (!slotSchemas || !Object.hasOwn(slotSchemas, slot)) throw gameConfigMismatch(`no schema registered for slot "${slot}"`);
  }
}

export type Provider = "google" | "github";
export interface SignInOptions { redirectTo?: string }
export interface Profile { handle: string | null }
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

  if (input.game) assertGameConfig(input.game);
  const saves: SavesClient | undefined = input.game
    ? createSavesClient({
        game: input.game,
        getSession: async () => { const s = await getSession(); return s ? { access_token: s.access_token, user: { id: s.user.id } } : null; },
        state: createSaveStateStore(input.game.gameSlug),
        transport: createTransport(`${config.nexusOrigin.replace(/\/+$/, "")}/api/saves/${input.game.routeAlias}`),
        prompt: createDomPromptHost(),
        onBackgroundStored: input.onBackgroundStored,
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
