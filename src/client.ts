import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

let client: SupabaseClient | null = null;

/** The ONE Supabase client for the page. Apps must not create their own. */
export function getSupabase(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

/** Test seam only. */
export function __setSupabaseForTests(fake: SupabaseClient | null): void {
  client = fake;
}
