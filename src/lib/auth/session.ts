import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SessionUser = { id: string; email: string | null };

/**
 * The single place the app asks "who is signed in?".
 * Returns null when signed out or when Supabase is not configured.
 * Reads cookies, so callers must render inside a <Suspense> boundary.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
