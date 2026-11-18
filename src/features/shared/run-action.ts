import "server-only";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError, NotFoundError, SupabaseNotConfiguredError } from "@/lib/db/client";
import type { ActionResult } from "./action-result";

function friendly(e: unknown): string {
  if (e instanceof DataValidationError) return e.message;
  if (e instanceof NotFoundError) return `${e.message} Refresh to see the latest.`;
  if (e instanceof SupabaseNotConfiguredError) return "Saving is off until Supabase is connected.";
  return "Could not save. Try again in a moment.";
}

/**
 * Runs a server action as the signed-in user. Input is validated inside
 * `fn` (lib/domain + lib/db). Revalidates `paths` on success so every
 * page showing the data updates.
 */
export async function runAction(paths: string[], fn: (userId: string) => Promise<unknown>): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to make changes." };
  try {
    await fn(user.id);
  } catch (e) {
    if (!(e instanceof DataValidationError) && !(e instanceof NotFoundError)) {
      console.error("[action]", e);
    }
    return { ok: false, error: friendly(e) };
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true };
}

/** Pages that show planning data. Revalidated after any planning change. */
export const PLANNING_PATHS = ["/", "/calendar", "/tasks", "/habits", "/areas", "/about-you"];
