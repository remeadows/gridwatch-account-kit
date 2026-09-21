import { getSupabase } from "./client.js";
import { NEXUS_ORIGIN } from "./config.js";
import { validateHandle } from "./handle.js";
import { signInUrl } from "./returnPath.js";
import { payloadSchemas, resolveSaveGame } from "./saves-schema/games.js";
import { ALIAS_RE, SLOT_RE } from "./saves-schema/wire.js";
import { createSavesClient } from "./saves/client.js";
import { createDomPromptHost } from "./saves/prompt.js";
import { createSaveStateStore } from "./saves/state.js";
import { createTransport } from "./saves/transport.js";
function gameConfigMismatch(what) {
    return new TypeError(`[account-kit] game config does not match the saves registry: ${what}`);
}
/** Fail fast when a game config was hand-typed wrong (transposed fields, a typo'd slot) instead
 *  of letting it silently 404/mismatch at runtime — the saves registry is the source of truth. */
function assertGameConfig(game) {
    if (!ALIAS_RE.test(game.routeAlias))
        throw gameConfigMismatch(`invalid routeAlias "${game.routeAlias}"`);
    for (const slot of game.slots) {
        if (!SLOT_RE.test(slot))
            throw gameConfigMismatch(`invalid slot "${slot}"`);
    }
    const registered = resolveSaveGame(game.routeAlias);
    if (!registered)
        throw gameConfigMismatch(`unknown routeAlias "${game.routeAlias}"`);
    if (registered.slug !== game.gameSlug)
        throw gameConfigMismatch(`gameSlug "${game.gameSlug}" does not match registry "${registered.slug}" for "${game.routeAlias}"`);
    const sameSlots = registered.slots.length === game.slots.length && registered.slots.every((slot) => game.slots.includes(slot));
    if (!sameSlots)
        throw gameConfigMismatch(`slots [${game.slots.join(", ")}] do not match registry [${registered.slots.join(", ")}] for "${game.routeAlias}"`);
    if (registered.schemaVersion !== game.schemaVersion)
        throw gameConfigMismatch(`schemaVersion ${game.schemaVersion} does not match registry ${registered.schemaVersion} for "${game.routeAlias}"`);
    const slotSchemas = payloadSchemas[game.gameSlug]?.[game.schemaVersion];
    for (const slot of game.slots) {
        if (!slotSchemas || !Object.hasOwn(slotSchemas, slot))
            throw gameConfigMismatch(`no schema registered for slot "${slot}"`);
    }
}
/** True when `e` carries a string `code` field (e.g. a PostgrestError), narrowing its type. */
function hasCode(e) {
    return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string";
}
export function createAccountKit(input) {
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
        }
        catch (thrown) {
            console.warn("[account-kit] getSession threw:", thrown instanceof Error ? thrown.message : String(thrown));
            return null;
        }
    }
    async function currentUserId() {
        return (await getSession())?.user.id ?? null;
    }
    // Contract, same as getSession(): never rejects. A refresh the saves client cannot use is
    // reported as "no session" (null), because that is precisely what the client does with it —
    // report the 401 it already has and tell us the session was rejected.
    async function refreshSession() {
        try {
            const { data, error } = await getSupabase().auth.refreshSession();
            if (error) {
                console.warn("[account-kit] refreshSession failed:", error.message);
                return null;
            }
            const s = data.session;
            return s ? { access_token: s.access_token, user: { id: s.user.id } } : null;
        }
        catch (thrown) {
            console.warn("[account-kit] refreshSession threw:", thrown instanceof Error ? thrown.message : String(thrown));
            return null;
        }
    }
    /** The saves API rejected `userId`'s token and no refresh could recover it — the session was
     *  revoked server-side (a sign-out elsewhere, an admin action). This device's cached JWT is
     *  usually still unexpired, so the header would go on showing the player's name while nothing
     *  syncs; ending the LOCAL session makes onAuthStateChange fire, and the header / useAccount
     *  fall back to "Sign in", which is the truth.
     *
     *  Local, never global: the rejection says nothing about this player's other devices, and
     *  ending their sessions is the very defect this release fixes (D1).
     *
     *  Only when the rejected user is still the signed-in one, re-checked here rather than trusted
     *  from the rejection: a saves operation can outlast a sign-out or an account switch, and a
     *  stale rejection for a previous account must not sign the current one out.
     *
     *  Contained end to end: this is a notification, and a failure to act on it must not surface as
     *  an unhandled rejection in the host page or change the result the saves call already has. */
    let endingLocalSession = null;
    function endLocalSession(userId) {
        // One check-then-sign-out at a time. Both slots are usually rejected together, and each extra
        // concurrent run is another chance for its sign-out to land after a DIFFERENT account has
        // become current. supabase-js can only sign out "the current session", so the check and the
        // sign-out cannot be made atomic; what can be done is to run the pair once, back to back, and
        // let later rejections join it. (Sign-in through the kit is a full-page redirect, which
        // discards this page and any sign-out still pending on it.)
        if (endingLocalSession)
            return endingLocalSession;
        endingLocalSession = (async () => {
            try {
                if ((await currentUserId()) !== userId)
                    return;
                const { error } = await getSupabase().auth.signOut({ scope: "local" });
                if (error)
                    console.warn("[account-kit] local sign-out after a rejected session failed:", error.message);
            }
            catch (thrown) {
                console.warn("[account-kit] local sign-out after a rejected session threw:", thrown instanceof Error ? thrown.message : String(thrown));
            }
            finally {
                endingLocalSession = null;
            }
        })();
        return endingLocalSession;
    }
    if (input.game)
        assertGameConfig(input.game);
    const saves = input.game
        ? createSavesClient({
            game: input.game,
            getSession: async () => { const s = await getSession(); return s ? { access_token: s.access_token, user: { id: s.user.id } } : null; },
            state: createSaveStateStore(input.game.gameSlug),
            transport: createTransport(`${config.nexusOrigin.replace(/\/+$/, "")}/api/saves/${input.game.routeAlias}`),
            prompt: createDomPromptHost(),
            onBackgroundStored: input.onBackgroundStored,
            refreshSession,
            onSessionRejected: (userId) => { void endLocalSession(userId); },
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
            // scope: "local" — never Supabase's default, which is GLOBAL and revokes every session the
            // player has anywhere. Signing out of this browser must not end their session on their phone:
            // the saves API validates tokens against Supabase, so a revoked-but-unexpired JWT leaves that
            // device still showing the player's name while every saves call answers 401.
            const { error } = await getSupabase().auth.signOut({ scope: "local" });
            if (error)
                throw new Error(error.message);
        },
        async getProfile() {
            const userId = await currentUserId();
            if (!userId)
                return { handle: null };
            const { data, error } = await getSupabase().from("profiles").select("handle").eq("user_id", userId).maybeSingle();
            if (error) {
                console.warn("[account-kit] profile load failed:", error.message);
                throw new Error(error.message);
            }
            return { handle: data?.handle ?? null };
        },
        async saveHandle(raw) {
            const userId = await currentUserId();
            if (!userId)
                return "Not signed in.";
            const trimmed = raw.trim();
            const invalid = validateHandle(trimmed);
            if (invalid)
                return invalid;
            const { error } = await getSupabase().from("profiles").upsert({ user_id: userId, handle: trimmed });
            if (error)
                return hasCode(error) && error.code === "23505" ? "That handle is taken." : error.message;
            return null;
        },
        signInUrl: defaultRedirect,
    };
}
