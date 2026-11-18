import type { PlanConflict, PlanItemAction, PlanKind, PlanTiming } from "@/features/assistant/plan-types";
import { cadenceLabel } from "@/lib/domain/habits";
import type { Commitment, HabitCadence, Task } from "@/lib/domain/types";
import { expandEvent, expandEvents, overlapping } from "@/lib/scheduling/recurrence";
import {
  addDaysToKey,
  dateKeyInZone,
  startOfDayInZone,
  startOfWeekKey,
  timeKeyInZone,
  zonedToUtc,
} from "@/lib/scheduling/zoned";
import {
  planSchedule,
  requestFromTask,
  type PlanRequest,
  type ProposedSession,
  type SchedulingPreferences,
} from "@/lib/scheduling/planner";
import type { ActionSpec, World } from "./assess";
import { clockLabel, shortDate } from "./dates";

/**
 * Turns ready action specs into a plan: a list of items with everything
 * the approval card shows and everything the apply step needs. Calendar
 * placement comes only from the deterministic scheduling engine. Pure:
 * the caller passes `now`, events and preferences. Unit tested.
 */

export type BlockRequestRef = PlanRequest;

export type ItemPayload = Record<string, unknown>;

export type ItemDisplay = {
  detail: string | null;
  timing: PlanTiming | null;
  previous: { start: string; end: string } | null;
  reason: string | null;
  tradeoffs: string[];
  conflicts: PlanConflict[];
  warnings: string[];
  alternatives: { start: string; end: string }[];
  editable: boolean;
};

export type NewPlanItem = {
  action: PlanItemAction;
  title: string;
  payload: ItemPayload;
  display: ItemDisplay;
  targetId: string | null;
  /** Apply right away (explicit, simple, organizational). Never true for calendar items. */
  autoApply: boolean;
};

export type BuiltPlan = {
  kind: PlanKind;
  items: NewPlanItem[];
  summary: string | null;
  unscheduled: { title: string; minutes: number; reason: string }[];
  /** Facts for the reply model ("Volleyball is a fixed event, left unchanged"). */
  notes: string[];
  /** Engine inputs kept for "find another time". */
  context: { requests: PlanRequest[]; window: { start: string; end: string } | null };
};

export type BuildInput = {
  now: string;
  world: World;
  preferences: SchedulingPreferences;
  /** Existing calendar (fresh from the database). */
  events: Commitment[];
  openTasks: Task[];
  /** Blocks proposed in other open plans, so plans never double-book. */
  busy: { start: string; end: string; title?: string }[];
  specs: { spec: ActionSpec; explicit: boolean }[];
  sourceMessageId: string | null;
};

const AUTO_APPLY: ReadonlySet<ActionSpec["kind"]> = new Set([
  "task_create",
  "task_update",
  "task_complete",
  "habit_create",
  "habit_update",
  "goal_create",
  "goal_update",
  "set_area",
  "prefs",
]);

const MAX_WINDOW_DAYS = 62;
const EMPTY_DISPLAY: ItemDisplay = {
  detail: null,
  timing: null,
  previous: null,
  reason: null,
  tradeoffs: [],
  conflicts: [],
  warnings: [],
  alternatives: [],
  editable: false,
};

export function timingFor(
  start: string,
  end: string,
  timeZone: string,
  extra: { allDay?: boolean; recurrence?: string | null } = {},
): PlanTiming {
  const s = new Date(start);
  const e = new Date(end);
  return {
    start: s.toISOString(),
    end: e.toISOString(),
    date: dateKeyInZone(s, timeZone),
    startTime: timeKeyInZone(s, timeZone),
    endTime: timeKeyInZone(e, timeZone),
    durationMinutes: Math.round((e.getTime() - s.getTime()) / 60_000),
    timeZone,
    allDay: extra.allDay ?? false,
    recurrence: extra.recurrence ?? null,
  };
}

function whenLabel(start: string, timeZone: string): string {
  const s = new Date(start);
  return `${shortDate(dateKeyInZone(s, timeZone))} at ${clockLabel(timeKeyInZone(s, timeZone))}`;
}

function dueLabel(dueAt: string | null, timeZone: string): string | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const time = timeKeyInZone(d, timeZone);
  return `Due ${shortDate(dateKeyInZone(d, timeZone))}${time === "23:59" ? "" : ` at ${clockLabel(time)}`}`;
}

function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function isFlexibleBlock(c: Commitment & { planItemId?: string | null }): boolean {
  return c.kind === "flexible" && !!c.startsAt;
}

/** Conflicts between a new event's next few occurrences and the existing calendar. */
function eventConflicts(event: Commitment, existing: Commitment[], now: Date, timeZone: string): PlanConflict[] {
  const horizon = new Date(now.getTime() + 28 * 86_400_000);
  const mine = expandEvent(event, now, horizon, timeZone);
  const theirs = expandEvents(existing, now, horizon, timeZone);
  const out: PlanConflict[] = [];
  const seen = new Set<string>();
  for (const occ of mine) {
    for (const other of overlapping(theirs, occ.start, occ.end)) {
      if (seen.has(other.event.id)) continue;
      seen.add(other.event.id);
      out.push({
        title: other.event.title,
        start: other.start.toISOString(),
        end: other.end.toISOString(),
        kind: other.event.kind,
      });
    }
  }
  return out.slice(0, 5);
}

function windowFor(
  spec: Extract<ActionSpec, { kind: "plan_time" }> | { window: "this_week" | "next_week" | "today" | "tomorrow" | "until_deadline" },
  input: BuildInput,
  deadline: Date | null,
): { start: Date; end: Date } {
  const { todayKey, timeZone, weekStartsOn } = input.world;
  const now = new Date(input.now);
  const day = (k: string) => startOfDayInZone(k, timeZone);
  const weekStart = startOfWeekKey(todayKey, weekStartsOn);
  let start = now;
  let end: Date;
  switch (spec.window) {
    case "today":
      end = day(addDaysToKey(todayKey, 1));
      break;
    case "tomorrow":
      start = day(addDaysToKey(todayKey, 1));
      end = day(addDaysToKey(todayKey, 2));
      break;
    case "next_week":
      start = day(addDaysToKey(weekStart, 7));
      end = day(addDaysToKey(weekStart, 14));
      break;
    case "until_deadline":
      end = deadline ?? day(addDaysToKey(weekStart, 7));
      break;
    default:
      end = day(addDaysToKey(weekStart, 7));
  }
  if (deadline && deadline < end) end = deadline;
  const max = new Date(now.getTime() + MAX_WINDOW_DAYS * 86_400_000);
  if (end > max) end = max;
  if (start < now) start = now;
  return { start, end };
}

function sessionReason(s: ProposedSession): string {
  const base = s.reasons.map((r) => r.text).join(" ");
  const part = s.count > 1 ? `Session ${s.index + 1} of ${s.count}. ` : "";
  return `${part}${base}`.trim() || "Free time inside your working hours.";
}

function blockItem(s: ProposedSession, request: PlanRequest, timeZone: string, sourceMessageId: string | null): NewPlanItem {
  const title = s.count > 1 ? `${s.title} (${s.index + 1} of ${s.count})` : s.title;
  return {
    action: "schedule_block",
    title,
    targetId: null,
    autoApply: false,
    payload: {
      title: s.title,
      lifeAreaId: request.lifeAreaId ?? null,
      taskId: request.taskId ?? null,
      startsAt: s.start,
      endsAt: s.end,
      timezone: timeZone,
      requestId: request.id,
      sourceMessageId,
    },
    display: {
      ...EMPTY_DISPLAY,
      timing: timingFor(s.start, s.end, timeZone),
      reason: sessionReason(s),
      tradeoffs: s.tradeoffs.map((t) => t.text),
      alternatives: s.alternatives,
      editable: true,
    },
  };
}

function cadenceText(c: HabitCadence): string {
  return cadenceLabel(c);
}

/** Commitment-shaped view of a pending new event, so the engine plans around it. */
function asCommitment(id: string, payload: ItemPayload): Commitment {
  return {
    id,
    title: String(payload.title),
    area: null,
    kind: "fixed",
    startsAt: String(payload.startsAt),
    endsAt: String(payload.endsAt),
    recurrenceRule: (payload.rrule as string | null) ?? null,
    timezone: String(payload.timezone),
  };
}

type Ctx = {
  items: NewPlanItem[];
  requests: PlanRequest[];
  /** request id -> how to turn its sessions into items */
  moves: Map<string, { block: Commitment }>;
  notes: string[];
  unscheduled: BuiltPlan["unscheduled"];
  windows: { start: Date; end: Date }[];
  extraEvents: Commitment[];
  excludeEventIds: Set<string>;
  extraBusy: { start: string; end: string; title?: string }[];
  adaptive: boolean;
};

function moveRequest(block: Commitment, ctx: Ctx, input: BuildInput, avoidDay: string | null, task: Task | null): void {
  if (!block.startsAt || !block.endsAt) return;
  const minutes = Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60_000);
  const tz = input.world.timeZone;
  const id = `m${ctx.requests.length}`;
  const originalDay = dateKeyInZone(new Date(block.startsAt), tz);
  const fallbackDeadline = startOfDayInZone(addDaysToKey(originalDay, 7), tz);
  const deadline = task?.dueAt ? new Date(task.dueAt) : fallbackDeadline;
  ctx.requests.push({
    id,
    title: block.title,
    amount: { type: "single", minutes },
    priority: task?.priority ?? "medium",
    deadline: deadline.toISOString(),
    earliestStart: null,
    lifeAreaId: block.lifeAreaId ?? null,
    taskId: task?.id ?? null,
    avoid: [{ start: block.startsAt, end: block.endsAt }],
  });
  ctx.moves.set(id, { block });
  ctx.excludeEventIds.add(block.id);
  if (avoidDay) {
    ctx.extraBusy.push({
      start: startOfDayInZone(avoidDay, tz).toISOString(),
      end: startOfDayInZone(addDaysToKey(avoidDay, 1), tz).toISOString(),
      title: "Unavailable",
    });
  }
  ctx.windows.push({ start: new Date(input.now), end: deadline });
}

export function buildPlan(input: BuildInput): BuiltPlan {
  const tz = input.world.timeZone;
  const now = new Date(input.now);
  const ctx: Ctx = {
    items: [],
    requests: [],
    moves: new Map(),
    notes: [],
    unscheduled: [],
    windows: [],
    extraEvents: [],
    excludeEventIds: new Set(),
    extraBusy: [],
    adaptive: false,
  };
  const tasksById = new Map(input.openTasks.map((t) => [t.id, t]));
  const futureBlocks = input.events.filter(
    (e) => isFlexibleBlock(e) && (e as Commitment & { planItemId?: string | null }).planItemId && e.startsAt && Date.parse(e.startsAt) > now.getTime(),
  ) as (Commitment & { planItemId?: string | null; taskId?: string | null })[];

  // ---- 1. Records and new events ----
  for (const { spec, explicit } of input.specs) {
    const auto = explicit && AUTO_APPLY.has(spec.kind);
    switch (spec.kind) {
      case "event": {
        const startsAt = zonedToUtc(spec.date, spec.startTime, tz).toISOString();
        const endsAt = zonedToUtc(spec.date, spec.endTime, tz).toISOString();
        const payload: ItemPayload = {
          title: spec.title,
          lifeAreaId: spec.lifeAreaId,
          kind: "fixed",
          startsAt,
          endsAt,
          timezone: tz,
          rrule: spec.rrule,
          location: spec.location,
          notes: spec.notes,
          sourceMessageId: input.sourceMessageId,
        };
        const asEvent = asCommitment(`new-${ctx.items.length}`, payload);
        const conflicts = eventConflicts(asEvent, input.events, now, tz);
        ctx.extraEvents.push(asEvent);
        ctx.items.push({
          action: "create_event",
          title: spec.title,
          targetId: null,
          autoApply: false,
          payload,
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(startsAt, endsAt, tz, { recurrence: spec.recurrenceText }),
            detail: spec.location ? `At ${spec.location}` : null,
            reason: spec.recurrenceText ? `${spec.recurrenceText}, as you described.` : "As you described.",
            conflicts,
            tradeoffs: conflicts.map((c) => `Overlaps ${c.title} (${whenLabel(c.start, tz)}).`),
            editable: true,
          },
        });
        // Sessions the assistant placed earlier that now collide get moved (with approval).
        const occ = expandEvent(asEvent, now, new Date(now.getTime() + 28 * 86_400_000), tz);
        for (const block of futureBlocks) {
          if (ctx.excludeEventIds.has(block.id)) continue;
          const hit = occ.some((o) => o.start < new Date(block.endsAt!) && o.end > new Date(block.startsAt!));
          if (hit) {
            ctx.adaptive = true;
            moveRequest(block, ctx, input, null, block.taskId ? tasksById.get(block.taskId) ?? null : null);
          }
        }
        break;
      }
      case "task_create": {
        const dueAt = spec.dueDate ? zonedToUtc(spec.dueDate, spec.dueTime ?? "23:59", tz).toISOString() : null;
        const detail = [dueLabel(dueAt, tz), spec.priority !== "medium" ? `${spec.priority[0].toUpperCase()}${spec.priority.slice(1)} priority` : null, spec.estimatedMinutes ? minutesLabel(spec.estimatedMinutes) : null]
          .filter(Boolean)
          .join(" · ");
        ctx.items.push({
          action: "create_task",
          title: spec.title,
          targetId: null,
          autoApply: auto,
          payload: {
            title: spec.title,
            description: spec.description,
            lifeAreaId: spec.lifeAreaId,
            dueAt,
            estimatedMinutes: spec.estimatedMinutes,
            priority: spec.priority,
          },
          display: { ...EMPTY_DISPLAY, detail: detail || null, reason: "New task." },
        });
        break;
      }
      case "task_update": {
        const patch: Record<string, unknown> = {};
        const parts: string[] = [];
        if (spec.patch.title) {
          patch.title = spec.patch.title;
          parts.push(`Rename to "${spec.patch.title}"`);
        }
        if (spec.patch.priority) {
          patch.priority = spec.patch.priority;
          parts.push(`${spec.patch.priority} priority`);
        }
        if (spec.patch.dueDate) {
          patch.due_at = zonedToUtc(spec.patch.dueDate, spec.patch.dueTime ?? "23:59", tz).toISOString();
          parts.push(dueLabel(String(patch.due_at), tz)!);
        }
        if (spec.patch.estimatedMinutes) {
          patch.estimated_minutes = spec.patch.estimatedMinutes;
          parts.push(`about ${minutesLabel(spec.patch.estimatedMinutes)}`);
        }
        ctx.items.push({
          action: "update_task",
          title: spec.task.title,
          targetId: spec.task.id,
          autoApply: auto,
          payload: { taskId: spec.task.id, patch },
          display: { ...EMPTY_DISPLAY, detail: parts.join(" · ") || null, reason: "Update to an existing task." },
        });
        break;
      }
      case "task_complete": {
        ctx.items.push({
          action: "complete_task",
          title: spec.task.title,
          targetId: spec.task.id,
          autoApply: auto,
          payload: { taskId: spec.task.id },
          display: { ...EMPTY_DISPLAY, detail: "Mark as done", reason: "You said it's finished." },
        });
        break;
      }
      case "habit_create":
      case "habit_update": {
        const isNew = spec.kind === "habit_create";
        ctx.items.push({
          action: isNew ? "create_habit" : "update_habit",
          title: isNew ? spec.title : spec.habit.title,
          targetId: isNew ? null : spec.habit.id,
          autoApply: auto,
          payload: isNew
            ? { title: spec.title, lifeAreaId: spec.lifeAreaId, cadence: spec.cadence }
            : { habitId: spec.habit.id, cadence: spec.cadence },
          display: { ...EMPTY_DISPLAY, detail: cadenceText(spec.cadence), reason: isNew ? "New habit." : "New frequency." },
        });
        break;
      }
      case "goal_create": {
        ctx.items.push({
          action: "create_goal",
          title: spec.title,
          targetId: null,
          autoApply: auto,
          payload: { title: spec.title, lifeAreaId: spec.lifeAreaId, targetDate: spec.targetDate, description: spec.description },
          display: { ...EMPTY_DISPLAY, detail: spec.targetDate ? `Target ${shortDate(spec.targetDate)}` : null, reason: "New goal." },
        });
        break;
      }
      case "goal_update": {
        const parts = [spec.progress !== null ? `${spec.progress}% done` : null, spec.targetDate ? `Target ${shortDate(spec.targetDate)}` : null].filter(Boolean);
        ctx.items.push({
          action: "update_goal",
          title: spec.goal.title,
          targetId: spec.goal.id,
          autoApply: auto,
          payload: { goalId: spec.goal.id, progress: spec.progress, targetDate: spec.targetDate },
          display: { ...EMPTY_DISPLAY, detail: parts.join(" · ") || null, reason: "Goal progress update." },
        });
        break;
      }
      case "set_area": {
        ctx.items.push({
          action: "set_life_area",
          title: spec.title,
          targetId: spec.id,
          autoApply: auto,
          payload: { table: spec.table, id: spec.id, lifeAreaId: spec.lifeAreaId },
          display: { ...EMPTY_DISPLAY, detail: `Move to ${spec.areaName}`, reason: "Categorized as you asked." },
        });
        break;
      }
      case "prefs": {
        const parts = [
          spec.dayStart ? `Start work no earlier than ${clockLabel(spec.dayStart)}` : null,
          spec.dayEnd ? `Finish work by ${clockLabel(spec.dayEnd)}` : null,
          spec.maxSessionMinutes ? `Sessions up to ${minutesLabel(spec.maxSessionMinutes)}` : null,
          spec.bufferMinutes !== null ? `${spec.bufferMinutes} min breaks between things` : null,
          spec.protectedTime ? `Keep ${clockLabel(spec.protectedTime.start)}–${clockLabel(spec.protectedTime.end)} free for ${spec.protectedTime.label}` : null,
        ].filter(Boolean);
        ctx.items.push({
          action: "update_preferences",
          title: "Scheduling preferences",
          targetId: null,
          autoApply: auto,
          payload: {
            dayStart: spec.dayStart,
            dayEnd: spec.dayEnd,
            maxSessionMinutes: spec.maxSessionMinutes,
            bufferMinutes: spec.bufferMinutes,
            protectedTime: spec.protectedTime,
          },
          display: { ...EMPTY_DISPLAY, detail: parts.join(" · "), reason: "Used for every plan from now on." },
        });
        break;
      }
      case "fact": {
        ctx.items.push({
          action: "save_fact",
          title: spec.title,
          targetId: null,
          autoApply: false,
          payload: {
            category: spec.category,
            title: spec.title,
            details: spec.details,
            lifeAreaId: spec.lifeAreaId,
            attributes: spec.attributes,
            sourceMessageId: input.sourceMessageId,
          },
          display: { ...EMPTY_DISPLAY, detail: spec.details, reason: "Something to remember about you." },
        });
        break;
      }
      case "plan_time": {
        const task = spec.taskId ? tasksById.get(spec.taskId) ?? null : null;
        let deadline: Date | null = null;
        if (spec.deadlineDate) {
          // Work must end before an exam or event that day, otherwise by the given time or end of day.
          const sameDay = [...ctx.extraEvents, ...input.events]
            .filter((e) => e.kind === "fixed" && e.startsAt && dateKeyInZone(new Date(e.startsAt), tz) === spec.deadlineDate && !e.recurrenceRule)
            .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))[0];
          deadline = spec.deadlineTime
            ? zonedToUtc(spec.deadlineDate, spec.deadlineTime, tz)
            : sameDay
              ? new Date(sameDay.startsAt!)
              : zonedToUtc(spec.deadlineDate, "23:59", tz);
        } else if (task?.dueAt) {
          deadline = new Date(task.dueAt);
        }
        const win = windowFor(spec, input, deadline);
        ctx.windows.push(win);
        ctx.requests.push({
          id: `r${ctx.requests.length}`,
          title: spec.title,
          amount: spec.amount,
          priority: spec.priority,
          deadline: (deadline && deadline <= win.end ? deadline : win.end).toISOString(),
          earliestStart: win.start.toISOString(),
          preferredDays: spec.preferredDays.length ? spec.preferredDays : undefined,
          lifeAreaId: spec.lifeAreaId,
          taskId: spec.taskId,
        });
        break;
      }
      case "cant_make": {
        ctx.adaptive = true;
        if (spec.event && spec.event.kind === "fixed") {
          if (spec.event.recurrenceRule && spec.date) {
            ctx.items.push({
              action: "skip_occurrence",
              title: spec.event.title,
              targetId: spec.event.id,
              autoApply: false,
              payload: { commitmentId: spec.event.id, date: spec.date },
              display: {
                ...EMPTY_DISPLAY,
                detail: `Skip ${shortDate(spec.date)} only. The rest of the series stays.`,
                reason: "You said you can't make it.",
              },
            });
          } else {
            ctx.notes.push(`${spec.event.title} is a fixed event. Whitespace leaves it unchanged; the user can edit it on the calendar.`);
          }
        }
        const blocks = spec.blocks.filter((b) => b.startsAt && Date.parse(b.startsAt) > now.getTime());
        if (!blocks.length && !spec.event) {
          ctx.notes.push(`No sessions scheduled by Whitespace match "${spec.title}"${spec.date ? ` on ${shortDate(spec.date)}` : ""}.`);
        }
        for (const block of blocks) {
          const linked = (block as Commitment & { taskId?: string | null }).taskId;
          moveRequest(block, ctx, input, spec.date, linked ? tasksById.get(linked) ?? null : null);
        }
        break;
      }
      case "finished_early": {
        ctx.adaptive = true;
        if (spec.task) {
          ctx.items.push({
            action: "complete_task",
            title: spec.task.title,
            targetId: spec.task.id,
            autoApply: explicit,
            payload: { taskId: spec.task.id },
            display: { ...EMPTY_DISPLAY, detail: "Mark as done", reason: "You finished it." },
          });
        }
        const words = spec.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const remaining = futureBlocks.filter(
          (b) => (spec.task && b.taskId === spec.task.id) || (!b.taskId && words.some((w) => b.title.toLowerCase().includes(w))),
        );
        for (const b of remaining) {
          ctx.items.push({
            action: "remove_block",
            title: b.title,
            targetId: b.id,
            autoApply: false,
            payload: { commitmentId: b.id },
            display: {
              ...EMPTY_DISPLAY,
              timing: timingFor(b.startsAt!, b.endsAt!, tz),
              detail: "Free up this time",
              reason: "No longer needed: you finished early.",
            },
          });
        }
        if (!remaining.length) ctx.notes.push(`No upcoming sessions for "${spec.title}" to remove.`);
        break;
      }
      case "not_enough_time": {
        ctx.adaptive = true;
        const win = windowFor({ window: spec.window }, input, null);
        ctx.windows.push(win);
        const scheduled = new Map<string, number>();
        for (const b of futureBlocks) {
          if (b.taskId) scheduled.set(b.taskId, (scheduled.get(b.taskId) ?? 0) + (Date.parse(b.endsAt!) - Date.parse(b.startsAt!)) / 60_000);
        }
        const noEstimate: string[] = [];
        for (const task of input.openTasks) {
          if (task.dueAt && Date.parse(task.dueAt) > win.end.getTime() + 7 * 86_400_000) continue;
          const req = requestFromTask(task);
          if (!req) {
            if (task.dueAt) noEstimate.push(task.title);
            continue;
          }
          const left = (req.amount.type === "total" ? req.amount.minutes : 0) - (scheduled.get(task.id) ?? 0);
          if (left < 15) continue;
          ctx.requests.push({ ...req, id: `r${ctx.requests.length}`, amount: { type: "total", minutes: Math.round(left) } });
        }
        if (noEstimate.length) {
          ctx.notes.push(`These tasks have no time estimate, so they were not counted: ${noEstimate.slice(0, 5).join(", ")}.`);
        }
        if (!ctx.requests.length) ctx.notes.push("No open tasks with time estimates need more time in this period.");
        break;
      }
    }
  }

  // ---- 2. One engine call for everything that needs time ----
  let summary: string | null = null;
  let window: { start: string; end: string } | null = null;
  if (ctx.requests.length) {
    const start = new Date(Math.min(...ctx.windows.map((w) => w.start.getTime()), now.getTime()));
    const maxEnd = new Date(now.getTime() + MAX_WINDOW_DAYS * 86_400_000);
    let end = new Date(Math.max(...ctx.windows.map((w) => w.end.getTime())));
    if (end > maxEnd) end = maxEnd;
    if (end <= start) end = new Date(start.getTime() + 86_400_000);
    window = { start: start.toISOString(), end: end.toISOString() };

    const result = planSchedule({
      now: input.now,
      timeZone: tz,
      window,
      events: [...input.events.filter((e) => !ctx.excludeEventIds.has(e.id)), ...ctx.extraEvents],
      busy: [...input.busy, ...ctx.extraBusy],
      preferences: input.preferences,
      requests: ctx.requests,
    });
    summary = result.summary;
    const byId = new Map(ctx.requests.map((r) => [r.id, r]));

    for (const s of result.sessions) {
      const move = ctx.moves.get(s.requestId);
      const request = byId.get(s.requestId)!;
      if (move) {
        ctx.items.push({
          action: "move_block",
          title: move.block.title,
          targetId: move.block.id,
          autoApply: false,
          payload: {
            commitmentId: move.block.id,
            startsAt: s.start,
            endsAt: s.end,
            fromStart: move.block.startsAt,
            fromEnd: move.block.endsAt,
            requestId: s.requestId,
          },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(s.start, s.end, tz),
            previous: { start: move.block.startsAt!, end: move.block.endsAt! },
            reason: `Moved from ${whenLabel(move.block.startsAt!, tz)}. ${sessionReason(s)}`,
            tradeoffs: s.tradeoffs.map((t) => t.text),
            alternatives: s.alternatives,
            editable: true,
          },
        });
      } else {
        ctx.items.push(blockItem(s, request, tz, input.sourceMessageId));
      }
    }

    for (const outcome of result.outcomes) {
      if (outcome.status === "scheduled") continue;
      const move = ctx.moves.get(outcome.requestId);
      if (move && outcome.status === "unscheduled") {
        ctx.items.push({
          action: "remove_block",
          title: move.block.title,
          targetId: move.block.id,
          autoApply: false,
          payload: { commitmentId: move.block.id },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(move.block.startsAt!, move.block.endsAt!, tz),
            detail: "Remove this session",
            reason: "You can't make it, and no other time fits before it's due.",
            tradeoffs: [outcome.issue?.message ?? "No free time left."],
          },
        });
        continue;
      }
      ctx.unscheduled.push({
        title: outcome.title,
        minutes: outcome.shortfallMinutes,
        reason: outcome.issue?.message ?? "Not enough free time.",
      });
    }
  }

  const hasBlocks = ctx.items.some((i) => i.action === "schedule_block");
  return {
    kind: ctx.adaptive ? "reschedule" : hasBlocks || ctx.requests.length ? "schedule" : "actions",
    items: ctx.items,
    summary,
    unscheduled: ctx.unscheduled,
    notes: ctx.notes,
    context: { requests: ctx.requests, window },
  };
}
