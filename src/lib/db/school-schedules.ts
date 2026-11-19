import "server-only";

import { bellScheduleSchema, toSchoolBlocks, type BellSchedule } from "@/lib/domain/school-schedule";
import { DataValidationError, dbError, requireDb } from "./client";
import type { Json } from "./database.types";

/**
 * The user's school bell schedule. Saving replaces the "School" events it
 * created before, in one transaction (save_school_schedule). RLS limits
 * every query to the signed-in user's own row.
 */

export type StoredSchoolSchedule =
  | { status: "none" }
  | { status: "skipped"; school: string | null; district: string | null }
  | { status: "saved"; school: string | null; district: string | null; schedule: BellSchedule; updatedAt: string };

export async function getSchoolSchedule(userId: string): Promise<StoredSchoolSchedule> {
  const supabase = await requireDb();
  const { data, error } = await supabase.from("school_schedules").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) return { status: "none" };
  if (data.status === "skipped") return { status: "skipped", school: data.school, district: data.district };
  const parsed = bellScheduleSchema.safeParse(data.schedule);
  // A malformed stored value shouldn't block anything: treat it as not set up.
  if (!parsed.success) return { status: "none" };
  return { status: "saved", school: data.school, district: data.district, schedule: parsed.data, updatedAt: data.updated_at };
}

export async function saveSchoolSchedule(
  userId: string,
  input: { schedule: unknown; school: string | null; district: string | null; timeZone: string; now?: Date },
): Promise<void> {
  const parsed = bellScheduleSchema.safeParse(input.schedule);
  if (!parsed.success) throw new DataValidationError(parsed.error.issues[0]?.message ?? "Check the schedule.");
  // Drop day types with no days: they'd never show up anywhere.
  const schedule: BellSchedule = { ...parsed.data, dayTypes: parsed.data.dayTypes.filter((d) => d.days.length) };
  const built = toSchoolBlocks(schedule, input.timeZone, input.now);
  if (!built.ok) throw new DataValidationError(built.error);

  const supabase = await requireDb();
  const { error } = await supabase.rpc("save_school_schedule", {
    p_schedule: schedule as unknown as Json,
    p_school: clean(input.school),
    p_district: clean(input.district),
    p_blocks: built.blocks as unknown as Json,
  });
  if (error) throw dbError(error);
  void userId; // RLS + auth.uid() scope the write; kept for a uniform signature.
}

/** "Not now": onboarding stops asking. Keeps a saved schedule's school name if one exists. */
export async function skipSchoolSchedule(
  userId: string,
  input: { school: string | null; district: string | null },
): Promise<void> {
  const supabase = await requireDb();
  const { data: existing, error: readError } = await supabase
    .from("school_schedules")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw dbError(readError);
  if (existing?.status === "saved") return; // never discard a saved schedule by skipping
  const { error } = await supabase
    .from("school_schedules")
    .upsert({ user_id: userId, status: "skipped", school: clean(input.school), district: clean(input.district) });
  if (error) throw dbError(error);
}

function clean(v: string | null): string | null {
  const t = v?.trim();
  return t ? t.slice(0, 120) : null;
}
