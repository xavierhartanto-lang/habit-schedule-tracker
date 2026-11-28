import "server-only";

import type { AutomationTemplate } from "@/lib/domain/templates";
import { readPayload, readSchedule } from "@/lib/domain/templates";
import type { Json } from "./database.types";
import { DatabaseError, dbError, requireDb } from "./client";

/**
 * Saved automations and the record of each time one staged a review card.
 * Only features/automations and the assistant call this.
 */

export function isMissingTemplates(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return (
    e?.code === "42P01" ||
    e?.code === "PGRST205" ||
    (/templates|template_runs/.test(e?.message ?? "") && /does not exist|schema cache/.test(e?.message ?? ""))
  );
}

function fromRow(row: {
  id: string;
  title: string;
  template_type: AutomationTemplate["templateType"];
  schedule_rule: Json;
  payload: Json;
  is_active: boolean;
}): AutomationTemplate | null {
  const schedule = readSchedule(row.schedule_rule);
  const payload = readPayload(row.payload);
  if (!schedule || !payload) return null;
  return { id: row.id, title: row.title, templateType: row.template_type, schedule, payload, active: row.is_active };
}

export async function listTemplates(userId: string): Promise<AutomationTemplate[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase.from("templates").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50);
  if (error) throw dbError(error);
  return data.flatMap((row) => {
    const template = fromRow(row);
    return template ? [template] : [];
  });
}

export async function insertTemplate(userId: string, input: Omit<AutomationTemplate, "id" | "active"> & { active?: boolean }): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("templates").insert({
    user_id: userId,
    title: input.title,
    template_type: input.templateType,
    schedule_rule: input.schedule as unknown as Json,
    payload: input.payload as unknown as Json,
    is_active: input.active !== false,
  });
  if (error) throw dbError(error);
}

/** Saves changes. Turns it on unless `keepActive` (an edit on the Automations page leaves on/off as it was). */
export async function updateTemplate(
  userId: string,
  id: string,
  input: Omit<AutomationTemplate, "id" | "active">,
  options: { keepActive?: boolean } = {},
): Promise<void> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("templates")
    .update({
      title: input.title,
      template_type: input.templateType,
      schedule_rule: input.schedule as unknown as Json,
      payload: input.payload as unknown as Json,
      ...(options.keepActive ? {} : { is_active: true }),
    })
    .eq("user_id", userId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new DatabaseError("Automation not found.", "P0002");
}

export async function setTemplateActive(userId: string, id: string, active: boolean): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("templates").update({ is_active: active }).eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}

export async function deleteTemplate(userId: string, id: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.from("templates").delete().eq("user_id", userId).eq("id", id);
  if (error) throw dbError(error);
}

/** True the first time this occurrence is claimed. False when a card was already staged. */
export async function claimTemplateRun(userId: string, templateId: string, occurrenceKey: string): Promise<boolean> {
  const supabase = await requireDb();
  const { error } = await supabase.from("template_runs").insert({ user_id: userId, template_id: templateId, occurrence_key: occurrenceKey });
  if (error?.code === "23505") return false;
  if (error) throw dbError(error);
  return true;
}

export async function attachTemplateRun(userId: string, templateId: string, occurrenceKey: string, planId: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase
    .from("template_runs")
    .update({ plan_id: planId })
    .eq("user_id", userId)
    .eq("template_id", templateId)
    .eq("occurrence_key", occurrenceKey);
  if (error) throw dbError(error);
}

export async function releaseTemplateRun(userId: string, templateId: string, occurrenceKey: string): Promise<void> {
  const supabase = await requireDb();
  await supabase.from("template_runs").delete().eq("user_id", userId).eq("template_id", templateId).eq("occurrence_key", occurrenceKey).is("plan_id", null);
}

export async function listRecentRunPlanIds(userId: string): Promise<string[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("template_runs")
    .select("plan_id")
    .eq("user_id", userId)
    .not("plan_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw dbError(error);
  return [...new Set(data.flatMap((row) => (row.plan_id ? [row.plan_id] : [])))];
}
