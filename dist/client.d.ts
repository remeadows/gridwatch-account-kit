import { type SupabaseClient } from "@supabase/supabase-js";
/** The ONE Supabase client for the page. Apps must not create their own. */
export declare function getSupabase(): SupabaseClient;
/** Test seam only. */
export declare function __setSupabaseForTests(fake: SupabaseClient | null): void;
