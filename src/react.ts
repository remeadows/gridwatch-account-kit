import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { AccountKit, Provider } from "./session.js";

/** Drop-in replacement for the apps' former useAuth(): same return shape. */
export function useAccount(kit: AccountKit) {
  const [session, setSession] = useState<Session | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);   // a new kit means a fresh read — don't keep showing the old kit's settled state
    let cancelled = false;
    let eventSeen = false;
    kit.getSession()
      .then((s) => {
        if (cancelled) return;
        if (!eventSeen) setSession(s);      // a newer auth event already set the session — keep it
      })
      .catch((thrown: unknown) => { console.warn("[account-kit] getSession rejected:", thrown); })   // kit contract says never; belt and braces
      .finally(() => { if (!cancelled) setLoading(false); });
    const off = kit.onChange((s) => { eventSeen = true; setSession(s); setLoading(false); });   // sync state only; profile loads in the effect below
    return () => { cancelled = true; off(); };
  }, [kit]);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) { setHandle(null); return; }
    setHandle(null);   // a new user must never inherit the previous user's handle while the read is in flight or if it fails
    let cancelled = false;
    kit.getProfile()
      .then(({ handle: h }) => { if (!cancelled) setHandle(h); })
      .catch((thrown: unknown) => { console.warn("[account-kit] getProfile rejected:", thrown); });   // kit contract: rejects on read failure; hook keeps current (null) handle
    return () => { cancelled = true; };
  }, [kit, userId]);

  const signInWithEmail = useCallback((email: string, redirectTo?: string) => kit.signInWithEmail(email, { redirectTo }), [kit]);
  const signInWithProvider = useCallback((provider: Provider, redirectTo?: string) => kit.signInWithProvider(provider, { redirectTo }), [kit]);
  // Bound to the user this render shows: if the account changes before submit, the kit refuses
  // rather than writing the handle onto the other account. A signed-out render has no one to bind to.
  const saveHandle = useCallback(async (raw: string) => {
    if (!userId) return "Not signed in.";
    const error = await kit.saveHandle(raw, userId);
    if (!error) setHandle(raw.trim());
    return error;
  }, [kit, userId]);
  const signOut = useCallback(
    () => kit.signOut().catch((thrown: unknown) => { console.warn("[account-kit] signOut failed:", thrown); }),
    [kit],
  );

  return { session, handle, loading, signInWithEmail, signInWithProvider, saveHandle, signOut };
}
