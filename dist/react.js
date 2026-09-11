import { useCallback, useEffect, useState } from "react";
/** Drop-in replacement for the apps' former useAuth(): same return shape. */
export function useAccount(kit) {
    const [session, setSession] = useState(null);
    const [handle, setHandle] = useState(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        setLoading(true); // a new kit means a fresh read — don't keep showing the old kit's settled state
        let cancelled = false;
        let eventSeen = false;
        kit.getSession()
            .then((s) => {
            if (cancelled)
                return;
            if (!eventSeen)
                setSession(s); // a newer auth event already set the session — keep it
        })
            .catch((thrown) => { console.warn("[account-kit] getSession rejected:", thrown); }) // kit contract says never; belt and braces
            .finally(() => { if (!cancelled)
            setLoading(false); });
        const off = kit.onChange((s) => { eventSeen = true; setSession(s); setLoading(false); }); // sync state only; profile loads in the effect below
        return () => { cancelled = true; off(); };
    }, [kit]);
    const userId = session?.user.id ?? null;
    useEffect(() => {
        if (!userId) {
            setHandle(null);
            return;
        }
        let cancelled = false;
        kit.getProfile()
            .then(({ handle: h }) => { if (!cancelled)
            setHandle(h); })
            .catch((thrown) => { console.warn("[account-kit] getProfile rejected:", thrown); }); // kit contract says never; belt and braces — handle stays null
        return () => { cancelled = true; };
    }, [kit, userId]);
    const signInWithEmail = useCallback((email, redirectTo) => kit.signInWithEmail(email, { redirectTo }), [kit]);
    const signInWithProvider = useCallback((provider, redirectTo) => kit.signInWithProvider(provider, { redirectTo }), [kit]);
    const saveHandle = useCallback(async (raw) => {
        const error = await kit.saveHandle(raw);
        if (!error)
            setHandle(raw.trim());
        return error;
    }, [kit]);
    const signOut = useCallback(() => kit.signOut(), [kit]);
    return { session, handle, loading, signInWithEmail, signInWithProvider, saveHandle, signOut };
}
