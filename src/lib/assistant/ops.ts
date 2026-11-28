import { z } from "zod";

import type { PlanItemAction } from "@/features/assistant/plan-types";
import { isRecurrenceRule } from "@/lib/domain/commitments";
import { validateOutgoingEmail } from "@/lib/domain/email";
import { validateTemplate, type ScheduleRule, type TemplatePayload, type TemplateType } from "@/lib/domain/templates";
import { WEEKDAYS, type Weekday } from "@/lib/domain/types";
import { zDateKey, zTime, zTimeZone, zUuid } from "@/lib/domain/validation";

/**
 * Stored plan item payload -> database operation for apply_plan_items.
 * Every payload is validated again here at approval time (it was written
 * by our own server, but stored JSON is never trusted blindly). Pure.
 */

export type Op = { item_id: string; op: string } & Record<string, unknown>;

const zIso = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)), "Invalid time.");
const zText = (max: number) => z.string().trim().min(1).max(max);
const zOptText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const zAreaId = zUuid.nullish().transform((v) => v ?? null);
const zDay = z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]);
const zPriority = z.enum(["high", "medium", "low"]);
const zRepeat = z.enum(["daily", "weekdays", "weekly", "monthly"]);
const zCadence = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily") }),
  z.object({ type: z.literal("weekly"), timesPerWeek: z.number().int().min(1).max(7) }),
  z.object({ type: z.literal("specific_days"), days: z.array(zDay).min(1).max(7) }),
]);

const range = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((v) => {
    const r = v as unknown as { startsAt: string; endsAt: string };
    return Date.parse(r.endsAt) > Date.parse(r.startsAt);
  }, "The end must be after the start.");

export const PAYLOAD_SCHEMAS = {
  create_event: range({
    title: zText(200),
    lifeAreaId: zAreaId,
    kind: z.literal("fixed"),
    startsAt: zIso,
    endsAt: zIso,
    timezone: zTimeZone,
    rrule: z.string().nullish().refine((v) => v == null || isRecurrenceRule(v), "Unsupported repeat rule.").transform((v) => v ?? null),
    location: zOptText(200),
    notes: zOptText(2000),
    sourceMessageId: zUuid.nullish(),
  }),
  schedule_block: range({
    title: zText(200),
    lifeAreaId: zAreaId,
    taskId: zUuid.nullish(),
    startsAt: zIso,
    endsAt: zIso,
    timezone: zTimeZone,
    requestId: z.string().max(80).nullish(),
    sourceMessageId: zUuid.nullish(),
  }),
  move_block: range({
    commitmentId: zUuid,
    startsAt: zIso,
    endsAt: zIso,
    fromStart: zIso.nullish(),
    fromEnd: zIso.nullish(),
    requestId: z.string().max(80).nullish(),
  }),
  remove_block: z.object({ commitmentId: zUuid }),
  remove_event: z.object({ commitmentId: zUuid }),
  skip_occurrence: z.object({ commitmentId: zUuid, date: zDateKey }),
  update_event: z.object({
    commitmentId: zUuid,
    patch: z
      .object({
        title: zText(200).optional(),
        starts_at: zIso.optional(),
        ends_at: zIso.optional(),
        recurrence_rule: z.string().nullable().refine((v) => v === null || isRecurrenceRule(v), "Unsupported repeat rule.").optional(),
        location: zOptText(200).optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, "Nothing to change.")
      .refine((p) => !("starts_at" in p) || ("ends_at" in p && Date.parse(p.ends_at!) > Date.parse(p.starts_at!)), "The end must be after the start."),
    expect: z.object({
      title: z.string(),
      starts_at: z.string().nullable(),
      ends_at: z.string().nullable(),
      recurrence_rule: z.string().nullable(),
    }),
    startsAt: zIso,
    endsAt: zIso,
    timezone: zTimeZone,
  }),
  create_task: z.object({
    title: zText(300),
    description: zOptText(2000),
    lifeAreaId: zAreaId,
    dueAt: zIso.nullish(),
    estimatedMinutes: z.number().int().min(1).max(1440).nullish(),
    priority: zPriority,
    repeat: zRepeat.nullish(),
  }),
  update_task: z.object({
    taskId: zUuid,
    patch: z
      .object({
        title: zText(300).optional(),
        priority: zPriority.optional(),
        due_at: zIso.optional(),
        estimated_minutes: z.number().int().min(1).max(1440).optional(),
        repeat: zRepeat.nullable().optional(),
      })
      .strict(),
  }),
  complete_task: z.object({ taskId: zUuid, nextDueAt: zIso.nullish() }),
  remove_task: z.object({ taskId: zUuid }),
  create_habit: z.object({ title: zText(200), lifeAreaId: zAreaId, cadence: zCadence }),
  update_habit: z.object({ habitId: zUuid, cadence: zCadence }),
  create_goal: z.object({ title: zText(200), lifeAreaId: zAreaId, targetDate: zDateKey.nullish(), description: zOptText(2000) }),
  update_goal: z.object({ goalId: zUuid, progress: z.number().int().min(0).max(100).nullable(), targetDate: zDateKey.nullish() }),
  set_life_area: z.object({ table: z.enum(["commitments", "tasks", "habits", "goals"]), id: zUuid, lifeAreaId: zAreaId }),
  update_preferences: z.object({
    dayStart: zTime.nullable(),
    dayEnd: zTime.nullable(),
    maxSessionMinutes: z.number().int().min(15).max(480).nullable(),
    bufferMinutes: z.number().int().min(0).max(60).nullable(),
    protectedTime: z
      .object({ label: zText(60), days: z.array(zDay).min(1).max(7), start: zTime, end: zTime })
      .nullable(),
  }),
  save_template: z
    .object({
      templateId: z.string().uuid().nullish(),
      title: z.string(),
      templateType: z.enum(["recurring_automation", "conditional_trigger", "email_template"]),
      schedule: z.record(z.string(), z.unknown()),
      payload: z.record(z.string(), z.unknown()),
    })
    .transform((value, ctx) => {
      const schedule = value.schedule as ScheduleRule;
      const payload = value.payload as TemplatePayload;
      const checked = validateTemplate({ title: value.title, templateType: value.templateType as TemplateType, schedule, payload });
      if (!checked.ok) {
        ctx.addIssue({ code: "custom", message: checked.error });
        return z.NEVER;
      }
      return { templateId: value.templateId ?? null, ...checked.value };
    }),
  cancel_template: z.object({ templateId: z.string().uuid(), title: z.string().min(1).max(200) }),
  send_email: z.object({ to: z.string(), subject: z.string(), body: z.string() }).transform((value, ctx) => {
    const checked = validateOutgoingEmail(value);
    if (!checked.ok) {
      ctx.addIssue({ code: "custom", message: checked.error });
      return z.NEVER;
    }
    return checked.value;
  }),
  save_fact: z.object({
    category: z.enum(["activity", "interest", "routine", "working_time", "preference"]),
    title: zText(200),
    details: zOptText(1000),
    lifeAreaId: zAreaId,
    attributes: z.record(z.string(), z.unknown()),
    sourceMessageId: zUuid.nullish(),
  }),
} satisfies Record<PlanItemAction, z.ZodType>;

export type Payload<A extends PlanItemAction> = z.infer<(typeof PAYLOAD_SCHEMAS)[A]>;

export function parsePayload<A extends PlanItemAction>(
  action: A,
  payload: unknown,
): { ok: true; value: Payload<A> } | { ok: false; error: string } {
  const schema = PAYLOAD_SCHEMAS[action] as unknown as z.ZodType<Payload<A>>;
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "This change is no longer valid." };
}

const ISO_DAY: Record<Weekday, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };

function habitColumns(c: z.infer<typeof zCadence>) {
  if (c.type === "daily") return { cadence: "daily", times_per_week: null, weekdays: null };
  if (c.type === "weekly") return { cadence: "weekly", times_per_week: c.timesPerWeek, weekdays: null };
  return { cadence: "specific_days", times_per_week: null, weekdays: c.days.map((d) => ISO_DAY[d]) };
}

/**
 * Builds the database operation for one item. `update_preferences` has no
 * op here: the app saves preferences itself, then marks the item applied.
 */
export function toOp(item: { id: string; action: PlanItemAction; payload: unknown }): { ok: true; op: Op } | { ok: false; error: string } {
  const base = { item_id: item.id };
  switch (item.action) {
    case "create_event": {
      const p = parsePayload("create_event", item.payload);
      if (!p.ok) return p;
      const v = p.value;
      return {
        ok: true,
        op: {
          ...base,
          op: "insert_commitment",
          guard: false,
          row: {
            title: v.title,
            life_area_id: v.lifeAreaId,
            kind: "fixed",
            starts_at: v.startsAt,
            ends_at: v.endsAt,
            timezone: v.timezone,
            recurrence_rule: v.rrule,
            location: v.location,
            notes: v.notes,
            source_message_id: v.sourceMessageId ?? null,
          },
        },
      };
    }
    case "schedule_block": {
      const p = parsePayload("schedule_block", item.payload);
      if (!p.ok) return p;
      const v = p.value;
      return {
        ok: true,
        op: {
          ...base,
          op: "insert_commitment",
          guard: true,
          row: {
            title: v.title,
            life_area_id: v.lifeAreaId,
            kind: "flexible",
            starts_at: v.startsAt,
            ends_at: v.endsAt,
            timezone: v.timezone,
            task_id: v.taskId ?? null,
            notes: "Scheduled by Whitespace",
            source_message_id: v.sourceMessageId ?? null,
          },
        },
      };
    }
    case "move_block": {
      const p = parsePayload("move_block", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "update_block_time", id: p.value.commitmentId, starts_at: p.value.startsAt, ends_at: p.value.endsAt } };
    }
    case "remove_block": {
      const p = parsePayload("remove_block", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "delete_block", id: p.value.commitmentId } };
    }
    case "remove_event": {
      const p = parsePayload("remove_event", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "delete_event", id: p.value.commitmentId } };
    }
    case "skip_occurrence": {
      const p = parsePayload("skip_occurrence", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "skip_occurrence", id: p.value.commitmentId, date: p.value.date } };
    }
    case "update_event": {
      const p = parsePayload("update_event", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "update_event", id: p.value.commitmentId, patch: p.value.patch, expect: p.value.expect } };
    }
    case "create_task": {
      const p = parsePayload("create_task", item.payload);
      if (!p.ok) return p;
      const v = p.value;
      return {
        ok: true,
        op: {
          ...base,
          op: "insert_task",
          row: {
            title: v.title,
            description: v.description,
            life_area_id: v.lifeAreaId,
            priority: v.priority,
            due_at: v.dueAt ?? null,
            estimated_minutes: v.estimatedMinutes ?? null,
            repeat: v.repeat ?? null,
          },
        },
      };
    }
    case "update_task": {
      const p = parsePayload("update_task", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "update_task", id: p.value.taskId, patch: p.value.patch } };
    }
    case "complete_task": {
      const p = parsePayload("complete_task", item.payload);
      if (!p.ok) return p;
      // nextDueAt means this occurrence is done and the same task comes back then.
      const patch = p.value.nextDueAt ? { due_at: p.value.nextDueAt, occurrence_done: true } : { status: "done" as const };
      return { ok: true, op: { ...base, op: "update_task", id: p.value.taskId, patch } };
    }
    case "remove_task": {
      const p = parsePayload("remove_task", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "remove_task", id: p.value.taskId } };
    }
    case "create_habit": {
      const p = parsePayload("create_habit", item.payload);
      if (!p.ok) return p;
      return {
        ok: true,
        op: { ...base, op: "insert_habit", row: { title: p.value.title, life_area_id: p.value.lifeAreaId, ...habitColumns(p.value.cadence) } },
      };
    }
    case "update_habit": {
      const p = parsePayload("update_habit", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "update_habit", id: p.value.habitId, patch: habitColumns(p.value.cadence) } };
    }
    case "create_goal": {
      const p = parsePayload("create_goal", item.payload);
      if (!p.ok) return p;
      const v = p.value;
      return {
        ok: true,
        op: {
          ...base,
          op: "insert_goal",
          row: { title: v.title, life_area_id: v.lifeAreaId, target_date: v.targetDate ?? null, description: v.description },
        },
      };
    }
    case "update_goal": {
      const p = parsePayload("update_goal", item.payload);
      if (!p.ok) return p;
      const patch: Record<string, unknown> = {};
      if (p.value.progress !== null) patch.progress = p.value.progress;
      if (p.value.targetDate) patch.target_date = p.value.targetDate;
      return { ok: true, op: { ...base, op: "update_goal", id: p.value.goalId, patch } };
    }
    case "set_life_area": {
      const p = parsePayload("set_life_area", item.payload);
      if (!p.ok) return p;
      return { ok: true, op: { ...base, op: "set_life_area", table: p.value.table, id: p.value.id, life_area_id: p.value.lifeAreaId } };
    }
    case "save_fact": {
      const p = parsePayload("save_fact", item.payload);
      if (!p.ok) return p;
      const v = p.value;
      return {
        ok: true,
        op: {
          ...base,
          op: "insert_context_item",
          row: {
            category: v.category,
            title: v.title,
            details: v.details,
            life_area_id: v.lifeAreaId,
            attributes: v.attributes,
            source_message_id: v.sourceMessageId ?? null,
          },
        },
      };
    }
    case "update_preferences":
      return { ok: false, error: "Preferences are saved by the app." };
    case "send_email":
      return { ok: false, error: "Email is sent by the app." };
    case "save_template":
      return { ok: false, error: "Automations are saved by the app." };
    case "cancel_template":
      return { ok: false, error: "Automations are saved by the app." };
  }
}
