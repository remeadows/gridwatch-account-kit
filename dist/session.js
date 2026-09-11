import { getSupabase } from "./client.js";
import { NEXUS_ORIGIN } from "./config.js";
import { validateHandle } from "./handle.js";
import { signInUrl } from "./returnPath.js";
export function createAccountKit(input) {
    const config = { returnPath: input.returnPath, nexusOrigin: input.nexusOrigin ?? NEXUS_ORIGIN };
    const defaultRedirect = () => signInUrl(config.returnPath, config.nexusOrigin);
    // Contract: getSession() never rejects. Any failure (auth error or thrown network error) is
    // logged and reported as "no session", so callers can always settle their loading state.
    async function getSession() {
        try {
            const { data, error } = await getSupabase().auth.getSession();
            if (error)
                console.warn("[account-kit] getSession failed:", error.message);
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
    return {
        config,
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
            await getSupabase().auth.signOut();
        },
        async getProfile() {
            const userId = await currentUserId();
            if (!userId)
                return { handle: null };
            const { data, error } = await getSupabase().from("profiles").select("handle").eq("user_id", userId).maybeSingle();
            if (error)
                console.warn("[account-kit] profile load failed:", error.message);
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
                return error.code === "23505" ? "That handle is taken." : error.message;
            return null;
        },
        signInUrl: defaultRedirect,
    };
}
