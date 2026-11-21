import "server-only";

import { dbError, requireDb } from "./client";
import type { Json, WeeklyBriefingRow } from "./database.types";

/**
 * Phase 7.6 weekly briefing cache: one row per (user, week_start). The
 * facts are always rebuilt live; this row only remembers the AI summary
 * (and which facts it was written from) and whether Home already showed
 * it. Every query runs as the signed-in user (RLS: own rows only).
 */

export type StoredBriefing = {
  weekStart: string;
  factsHash: string;
  summary: string | null;
  generatedAt: string;
  shownAt: string | null;
  dismissedAt: string | null;
};

function toStored(row: WeeklyBriefingRow): StoredBriefing {
  return {
    weekStart: row.week_start,
    factsHash: row.facts_hash,
    summary: row.summary,
    generatedAt: row.generated_at,
    shownAt: row.shown_at,
    dismissedAt: row.dismissed_at,
  };
}

/** The migration (20261130000000) hasn't been run yet. */
export function isMissingBriefingTable(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || (/weekly_briefings/.test(e.message ?? "") && /does not exist|schema cache/.test(e.message ?? "")));
}

export async function getBriefing(userId: string, weekStart: string): Promise<StoredBriefing | null> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("weekly_briefings")
    .select("*")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw dbError(error);
  return data ? toStored(data) : null;
}

/**
 * Idempotent: one row per week. Writing the same facts again changes
 * nothing that matters; new facts replace the summary.
 */
export async function saveBriefing(
  userId: string,
  v: { weekStart: string; factsHash: string; facts: Json; summary: string | null },
): Promise<StoredBriefing> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("weekly_briefings")
    .upsert(
      {
        user_id: userId,
        week_start: v.weekStart,
        facts_hash: v.factsHash,
        facts: v.facts,
        summary: v.summary,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_start" },
    )
    .select("*")
    .single();
  if (error) throw dbError(error);
  return toStored(data);
}

/** Home showed it (first time only) or the user closed it. */
export async function markBriefing(userId: string, weekStart: string, mark: "shown" | "dismissed", now = new Date()): Promise<void> {
  const supabase = await requireDb();
  const at = now.toISOString();
  let query = supabase
    .from("weekly_briefings")
    .update(mark === "shown" ? { shown_at: at } : { dismissed_at: at })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (mark === "shown") query = query.is("shown_at", null);
  const { error } = await query;
  if (error) throw dbError(error);
}
