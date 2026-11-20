"use server";

import { getSessionUser } from "@/lib/auth/session";
import { isDateKey } from "@/lib/scheduling/zoned";
import { markBriefingFor } from "./server/weekly";

/** Phase 7.6: remember that Home showed the weekly briefing, or that the user closed it. */

type Result = { ok: true } | { ok: false; error: string };

async function mark(input: { weekStart: string }, how: "shown" | "dismissed"): Promise<Result> {
  if (!isDateKey(input?.weekStart)) return { ok: false, error: "That briefing wasn't found." };
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to continue." };
  try {
    await markBriefingFor(user.id, input.weekStart, how);
    return { ok: true };
  } catch (error) {
    console.error("[insights] briefing mark failed", error);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

export async function markBriefingShown(input: { weekStart: string }): Promise<Result> {
  return mark(input, "shown");
}

export async function dismissBriefing(input: { weekStart: string }): Promise<Result> {
  return mark(input, "dismissed");
}
