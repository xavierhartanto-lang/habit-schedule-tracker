"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/database.types";
import { getSupabaseEnv } from "./env";

/** Browser client. Uses the publishable key only; RLS protects every row. */
export function createSupabaseBrowserClient() {
  const env = getSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured. See .env.example.");
  return createBrowserClient<Database>(env.url, env.key);
}
