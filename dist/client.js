import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
let client = null;
/** The ONE Supabase client for the page. Apps must not create their own. */
export function getSupabase() {
    if (!client)
        client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
}
/** Test seam only. */
export function __setSupabaseForTests(fake) {
    client = fake;
}
