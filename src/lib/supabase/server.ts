import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { Database } from "@/lib/db/database.types";
import { getSupabaseEnv } from "./env";

/**
 * Per-request server client bound to the user's auth cookies.
 * Returns null when Supabase env vars are missing so the UI can still render.
 */
export async function createSupabaseServerClient() {
  const env = getSupabaseEnv();
  if (!env) return null;

  // Auth checks read the clock (token expiry), so always run per request.
  await connection();
  const cookieStore = await cookies();
  return createServerClient<Database>(env.url, env.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // The proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
