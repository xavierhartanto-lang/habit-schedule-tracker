import type { PlanConflict, PlanItemAction, PlanKind, PlanTiming } from "@/features/assistant/plan-types";
import { cadenceLabel } from "@/lib/domain/habits";
import type { Commitment, HabitCadence, Task } from "@/lib/domain/types";
import { describeRecurrence, expandEvent, expandEvents, overlapping, parseRRule } from "@/lib/scheduling/recurrence";
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
import { analyze, capacityBefore, type Analysis } from "@/lib/proactive/analyze";
import { catchUpPlan } from "@/lib/proactive/catch-up";
import { examPrepPlan, hasPrep, isExam } from "@/lib/proactive/exam";
import { pickKeeper } from "@/lib/proactive/conflict-pick";
import { realityCheck } from "@/lib/proactive/reality";
import type { ActionSpec, World } from "./assess";
import { clockLabel, shortDate } from "./dates";
import { isGenericToken, nameScore, nameTokens } from "./resolve";
import { planCleanup } from "./duplicates";

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
  /** Short "why" labels for the card ("After Math", "10m buffer"). The full sentence stays in `reason`. */
  chips?: ItemChip[];
  /** Busy blocks around a session, drawn on the card's time strip. */
  nearby?: { title: string; start: string; end: string }[];
  /** Deadline of the work this session is for. */
  deadline?: string | null;
  /** Set when the session is for one step of a bigger task. */
  step?: StepInfo | null;
};

export type ItemChip = { code: string; label: string; tone: "plain" | "warn" };

/** A step of a bigger task, with its open siblings in order, so the card can draw the step path. */
export type StepInfo = { parentId: string; parentTitle: string; currentId: string; steps: { id: string; title: string; dueAt: string | null }[] };

export type NewPlanItem = {
  action: PlanItemAction;
  title: string;
  payload: ItemPayload;
  display: ItemDisplay;
  targetId: string | null;
  /** Apply right away (explicit, simple, organizational). Calendar items only when `commanded`. */
  autoApply: boolean;
  /**
   * The user directly told Whitespace to do exactly this ("remove the dentist",
   * "remove the duplicates, keep the Google one"): it happens now, with Undo.
   * Never set on anything Whitespace proposes on its own.
   */
  commanded?: boolean;
  /** The conversation action this item belongs to (see action-state.ts). */
  actionId?: string | null;
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
  busy: { start: string; end: string; title?: string; taskId?: string | null }[];
  specs: { spec: ActionSpec; explicit: boolean; actionId?: string | null }[];
  sourceMessageId: string | null;
};

// Records the user directly asked for apply right away. Finishing a task is
// handled separately (always applies, with Undo on the card).
const AUTO_APPLY: ReadonlySet<ActionSpec["kind"]> = new Set([
  "task_create",
  "task_update",
  "habit_create",
  "habit_update",
  "goal_create",
  "goal_update",
  "set_area",
  "prefs",
]);

const MAX_WINDOW_DAYS = 62;
/** New tasks shorter than this get no sessions of their own: they fit in any gap. */
const MIN_NEW_TASK_SESSION = 30;
const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

/** A long repeating block (School 8-3) that a new event sits entirely inside. */
function containsDay(other: { start: Date; end: Date }, mine: { start: Date; end: Date }): boolean {
  return other.start <= mine.start && other.end >= mine.end && other.end.getTime() - other.start.getTime() >= 3 * 3_600_000;
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

/** Why this slot. Session numbering lives in the title, so the engine's "spread" note is left out. */
function sessionChips(s: ProposedSession): ItemChip[] {
  const why = s.reasons
    .filter((r) => r.code !== "spread" && r.short)
    .slice(0, 3)
    .map((r): ItemChip => ({ code: r.code, label: r.short!, tone: "plain" }));
  const watch = s.tradeoffs.filter((r) => r.short).slice(0, 2).map((r): ItemChip => ({ code: r.code, label: r.short!, tone: "warn" }));
  return [...watch, ...why].slice(0, 4);
}

/** Open steps of the parent task, in order, when the session belongs to a step. */
export function stepInfo(task: Task | null | undefined, openTasks: readonly Task[]): StepInfo | null {
  if (!task?.parentTaskId) return null;
  const parent = openTasks.find((t) => t.id === task.parentTaskId);
  const steps = openTasks
    .filter((t) => t.parentTaskId === task.parentTaskId)
    .sort((a, b) => (a.dueAt ?? "\uffff").localeCompare(b.dueAt ?? "\uffff") || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .slice(0, 8)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt }));
  if (steps.length < 2) return null;
  return { parentId: task.parentTaskId, parentTitle: parent?.title ?? "", currentId: task.id, steps };
}

function sessionVisuals(s: ProposedSession, step: StepInfo | null): Pick<ItemDisplay, "chips" | "nearby" | "deadline" | "step"> {
  return { chips: sessionChips(s), nearby: s.nearby ?? [], deadline: s.deadline ?? null, step };
}

function sessionReason(s: ProposedSession): string {
  return s.reasons.filter((r) => r.code !== "spread").map((r) => r.text).join(" ").trim() || "Free time inside your working hours.";
}

/** "(1 of 3)" numbering in calendar order per request. */
function sessionNumbers(sessions: ProposedSession[]): Map<string, { n: number; of: number }> {
  const byRequest = new Map<string, ProposedSession[]>();
  for (const s of sessions) byRequest.set(s.requestId, [...(byRequest.get(s.requestId) ?? []), s]);
  const out = new Map<string, { n: number; of: number }>();
  for (const list of byRequest.values()) {
    list
      .slice()
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .forEach((s, i) => out.set(s.id, { n: i + 1, of: list.length }));
  }
  return out;
}

function blockItem(
  s: ProposedSession,
  numbering: { n: number; of: number } | undefined,
  request: PlanRequest,
  timeZone: string,
  sourceMessageId: string | null,
  step: StepInfo | null = null,
): NewPlanItem {
  const title = numbering && numbering.of > 1 ? `${s.title} (${numbering.n} of ${numbering.of})` : s.title;
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
      ...sessionVisuals(s, step),
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
  /** request id -> how to turn its sessions into items. `commanded`: part of the user's own command, applied now. */
  moves: Map<string, { block: Commitment; commanded?: boolean; keepIfNoRoom?: boolean }>;
  notes: string[];
  unscheduled: BuiltPlan["unscheduled"];
  windows: { start: Date; end: Date }[];
  extraEvents: Commitment[];
  excludeEventIds: Set<string>;
  extraBusy: { start: string; end: string; title?: string }[];
  adaptive: boolean;
};

function moveRequest(
  block: Commitment,
  ctx: Ctx,
  input: BuildInput,
  avoidDay: string | null,
  task: Task | null,
  options: { commanded?: boolean; within?: { start: Date; end: Date }; avoid?: { start: string; end: string }[]; keepIfNoRoom?: boolean } = {},
): void {
  if (!block.startsAt || !block.endsAt) return;
  const minutes = Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60_000);
  const tz = input.world.timeZone;
  const id = `m${ctx.requests.length}`;
  const originalDay = dateKeyInZone(new Date(block.startsAt), tz);
  const fallbackDeadline = startOfDayInZone(addDaysToKey(originalDay, 7), tz);
  // "Move my essay sessions to Saturday": only that day. Otherwise before it's due, or within a week.
  const deadline = options.within?.end ?? (task?.dueAt && Date.parse(task.dueAt) > Date.parse(input.now) ? new Date(task.dueAt) : fallbackDeadline);
  ctx.requests.push({
    id,
    title: block.title,
    amount: { type: "single", minutes },
    priority: task?.priority ?? "medium",
    deadline: deadline.toISOString(),
    earliestStart: options.within ? options.within.start.toISOString() : null,
    lifeAreaId: block.lifeAreaId ?? null,
    taskId: task?.id ?? null,
    avoid: [{ start: block.startsAt, end: block.endsAt }, ...(options.avoid ?? [])],
  });
  ctx.moves.set(id, { block, commanded: options.commanded, keepIfNoRoom: options.keepIfNoRoom });
  ctx.excludeEventIds.add(block.id);
  if (avoidDay) {
    ctx.extraBusy.push({
      start: startOfDayInZone(avoidDay, tz).toISOString(),
      end: startOfDayInZone(addDaysToKey(avoidDay, 1), tz).toISOString(),
      title: "Unavailable",
    });
  }
  ctx.windows.push({ start: options.within?.start ?? new Date(input.now), end: deadline });
}

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 } as const;
const SESSION_WORDS = /\b(?:sessions?|study time|work time|study blocks?|blocks?)\b/i;

/** Does a bulk-change filter ("history essay sessions", "study sessions", "tutoring") pick this item? */
function bulkMatches(filter: string | null, event: Commitment, isBlock: boolean): boolean {
  if (!filter) return true;
  const sessionsOnly = SESSION_WORDS.test(filter);
  if (sessionsOnly && !isBlock) return false;
  const specific = nameTokens(filter).filter((t) => !isGenericToken(t));
  if (sessionsOnly && !specific.length) return true;
  // "History essay sessions": every specific word must be in the name (College Essay Draft is not one).
  if (specific.length) {
    const title = nameTokens(event.title);
    return specific.every((t) => title.includes(t));
  }
  return nameScore(filter, event.title) >= 0.15;
}

/** Tags the items and scheduling requests one spec produced with its conversation action. */
function stampAction(
  ctx: Ctx,
  itemsBefore: number,
  requestsBefore: number,
  requestAction: Map<string, string>,
  actionId: string | null,
  build: () => void,
): void {
  build();
  if (!actionId) return;
  for (let i = itemsBefore; i < ctx.items.length; i++) ctx.items[i].actionId = actionId;
  for (let i = requestsBefore; i < ctx.requests.length; i++) requestAction.set(ctx.requests[i].id, actionId);
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

  // Minutes already set aside for each task: future blocks on the calendar
  // plus blocks still waiting for approval in other plans.
  const bookedByTask = new Map<string, number>();
  const book = (taskId: string | null | undefined, start: string, end: string) => {
    if (taskId) bookedByTask.set(taskId, (bookedByTask.get(taskId) ?? 0) + (Date.parse(end) - Date.parse(start)) / 60_000);
  };
  for (const b of futureBlocks) book(b.taskId, b.startsAt!, b.endsAt!);
  for (const b of input.busy) if (Date.parse(b.end) > now.getTime()) book(b.taskId, b.start, b.end);

  // Free time and competing work for the reality check, computed once.
  let analysis: Analysis | null | undefined;
  const getAnalysis = (): Analysis | null => {
    if (analysis === undefined) {
      try {
        analysis = analyze({ now: input.now, timeZone: tz, weekStartsOn: input.world.weekStartsOn, events: input.events, tasks: input.openTasks, preferences: input.preferences, busy: input.busy });
      } catch {
        analysis = null; // invalid zone or preferences: skip the check, never the record
      }
    }
    return analysis;
  };
  const realityFor = (title: string, dueMs: number, minutes: number) => {
    const a = getAnalysis();
    return a ? realityCheck(a, { title, dueMs, minutes }) : null;
  };
  /** Scheduling requests for tasks created on this same card: their sessions link to the task on approval. */
  const newTaskRequests = new Set<string>();
  /** plan_time requests where the user said "make room": lower-priority sessions may move out of the way. */
  const makeRoomFor = new Set<string>();

  // ---- 1. Records and new events ----
  // Which conversation action produced each item and each scheduling request.
  const requestAction = new Map<string, string>();
  for (const { spec, explicit, actionId } of input.specs) {
    const itemsBefore = ctx.items.length;
    const requestsBefore = ctx.requests.length;
    stampAction(ctx, itemsBefore, requestsBefore, requestAction, actionId ?? null, () => buildRecord(spec, explicit, !!actionId));
  }
  /**
   * Sessions the assistant placed earlier that a new or changed event now
   * collides with are moved on the same card (with approval), so one change
   * never leaves a broken plan behind (7.5 grouped repair).
   */
  function moveCollidingSessions(occ: { start: Date; end: Date }[], commanded = false): void {
    let moved = 0;
    for (const block of futureBlocks) {
      if (ctx.excludeEventIds.has(block.id)) continue;
      const hit = occ.some((o) => o.start < new Date(block.endsAt!) && o.end > new Date(block.startsAt!));
      if (hit) {
        ctx.adaptive = true;
        moveRequest(block, ctx, input, null, block.taskId ? tasksById.get(block.taskId) ?? null : null, {
          commanded,
          avoid: occ.map((o) => ({ start: o.start.toISOString(), end: o.end.toISOString() })),
        });
        moved++;
      }
    }
    if (moved) {
      ctx.notes.push(
        commanded
          ? `${moved} Whitespace session${moved === 1 ? " was" : "s were"} in the way, so ${moved === 1 ? "it was" : "they were"} moved to a free time (already done, Undo on the card).`
          : `${moved} Whitespace session${moved === 1 ? "" : "s"} would collide with this change, so new times for ${moved === 1 ? "it are" : "them are"} on the same card.`,
      );
    }
  }

  /**
   * "Push everything tomorrow back an hour", "move my essay sessions to Saturday",
   * "clear tomorrow", "cancel my study sessions this week". Picks every matching
   * calendar item in the period from the full calendar, then:
   * - Google Calendar events never change (explained);
   * - repeating events: clearing skips that day; moving changes that day only
   *   when the user named them, otherwise they stay (explained);
   * - one-time events move or go;
   * - Whitespace sessions move (by the shift, or to a free time on the new day);
   *   clearing a day re-plans them on other days, unless the user named the sessions.
   */
  function bulkChange(spec: Extract<ActionSpec, { kind: "bulk_change" }>, commanded: boolean): void {
    ctx.adaptive = true;
    const rangeStart = new Date(
      Math.max(
        now.getTime(),
        spec.fromTime ? zonedToUtc(spec.from, spec.fromTime, tz).getTime() : startOfDayInZone(spec.from, tz).getTime(),
      ),
    );
    const rangeEnd = startOfDayInZone(spec.to, tz);
    const period = spec.to === addDaysToKey(spec.from, 1) ? shortDate(spec.from) : `${shortDate(spec.from)} to ${shortDate(addDaysToKey(spec.to, -1))}`;
    if (rangeEnd <= rangeStart) {
      ctx.notes.push(`${period} is already over, so nothing was changed.`);
      return;
    }
    const isBlock = (e: Commitment) => e.kind === "flexible" && !!(e as Commitment & { planItemId?: string | null }).planItemId;
    const occurrences = expandEvents(input.events.filter((e) => e.startsAt && e.endsAt), rangeStart, rangeEnd, tz).filter(
      (o) => !o.allDay && o.start >= rangeStart && bulkMatches(spec.filter, o.event, isBlock(o.event)),
    );
    if (!occurrences.length) {
      ctx.notes.push(`Nothing on the calendar ${spec.filter ? `matches "${spec.filter}" ` : ""}for ${period}, so nothing was changed. Say so plainly.`);
      return;
    }
    const google: string[] = [];
    const repeating: string[] = [];
    const done: string[] = [];
    const named = !!spec.filter;
    const sessionsNamed = !!spec.filter && SESSION_WORDS.test(spec.filter);
    const movedIds = new Set(occurrences.filter((o) => !o.event.externalSource && (!o.recurring || named)).map((o) => o.key));
    const staying = expandEvents(input.events, startOfDayInZone(spec.from, tz), new Date(rangeEnd.getTime() + 86_400_000), tz).filter((o) => !o.allDay && !movedIds.has(o.key));
    const clearedRange = { start: rangeStart.toISOString(), end: rangeEnd.toISOString() };

    for (const o of occurrences) {
      const e = o.event;
      const time = `${clockLabel(timeKeyInZone(o.start, tz))}-${clockLabel(timeKeyInZone(o.end, tz))}`;
      if (e.externalSource) {
        google.push(e.title);
        continue;
      }
      const task = e.taskId ? tasksById.get(e.taskId) ?? null : null;
      if (spec.mode === "clear") {
        if (isBlock(e)) {
          if (sessionsNamed || named) {
            ctx.items.push({
              action: "remove_block",
              title: e.title,
              targetId: e.id,
              autoApply: commanded,
              commanded,
              payload: { commitmentId: e.id },
              display: { ...EMPTY_DISPLAY, timing: timingFor(o.start.toISOString(), o.end.toISOString(), tz), detail: "Remove this session", reason: "You asked to cancel it. Undo brings it back." },
            });
            done.push(`${e.title} (${shortDate(o.date)})`);
          } else {
            // The work still needs doing: it goes to a free time outside the cleared period.
            moveRequest(e, ctx, input, null, task, { commanded, avoid: [clearedRange] });
          }
        } else if (o.recurring) {
          ctx.items.push({
            action: "skip_occurrence",
            title: e.title,
            targetId: e.id,
            autoApply: commanded,
            commanded,
            payload: { commitmentId: e.id, date: o.date },
            display: { ...EMPTY_DISPLAY, detail: `Skip ${shortDate(o.date)}, ${time} only. The rest of the series stays.`, reason: "You asked to clear it." },
          });
          done.push(`${e.title} (${shortDate(o.date)} only)`);
        } else {
          ctx.items.push({
            action: "remove_event",
            title: e.title,
            targetId: e.id,
            autoApply: commanded,
            commanded,
            payload: { commitmentId: e.id },
            display: { ...EMPTY_DISPLAY, detail: `${shortDate(o.date)}, ${time}`, reason: "You asked to clear it. Undo brings it back." },
          });
          done.push(`${e.title} (${shortDate(o.date)})`);
        }
        continue;
      }

      // Moving.
      if (o.recurring && !named) {
        repeating.push(e.title);
        continue;
      }
      const length = o.end.getTime() - o.start.getTime();
      const newStart = spec.shiftMinutes
        ? new Date(o.start.getTime() + spec.shiftMinutes * 60_000)
        : zonedToUtc(spec.targetDate!, timeKeyInZone(o.start, tz), tz);
      const newEnd = new Date(newStart.getTime() + length);
      if (isBlock(e)) {
        const clash = overlapping(staying, newStart, newEnd).some((x) => x.event.id !== e.id);
        if (spec.targetDate || clash) {
          // A free time that day (the new day, or the same day when the shifted time is taken).
          const day = spec.targetDate ?? dateKeyInZone(newStart, tz);
          const start = new Date(Math.max(now.getTime(), startOfDayInZone(day, tz).getTime()));
          moveRequest(e, ctx, input, null, task, { commanded, within: { start, end: startOfDayInZone(addDaysToKey(day, 1), tz) }, keepIfNoRoom: true });
          continue;
        }
        ctx.items.push({
          action: "move_block",
          title: e.title,
          targetId: e.id,
          autoApply: commanded,
          commanded,
          payload: { commitmentId: e.id, startsAt: newStart.toISOString(), endsAt: newEnd.toISOString(), fromStart: e.startsAt, fromEnd: e.endsAt },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(newStart.toISOString(), newEnd.toISOString(), tz),
            previous: { start: e.startsAt!, end: e.endsAt! },
            reason: `Moved from ${whenLabel(e.startsAt!, tz)}, as you asked.`,
            editable: true,
          },
        });
        ctx.excludeEventIds.add(e.id);
        ctx.extraBusy.push({ start: newStart.toISOString(), end: newEnd.toISOString(), title: e.title });
        done.push(`${e.title} to ${whenLabel(newStart.toISOString(), tz)}`);
        continue;
      }
      const payload: ItemPayload = {
        title: e.title,
        lifeAreaId: e.lifeAreaId ?? null,
        kind: "fixed",
        startsAt: newStart.toISOString(),
        endsAt: newEnd.toISOString(),
        timezone: e.timezone ?? tz,
        rrule: null,
        location: e.location ?? null,
        notes: e.notes ?? null,
        sourceMessageId: input.sourceMessageId,
      };
      if (o.recurring) {
        ctx.items.push({
          action: "skip_occurrence",
          title: e.title,
          targetId: e.id,
          autoApply: commanded,
          commanded,
          payload: { commitmentId: e.id, date: o.date },
          display: { ...EMPTY_DISPLAY, detail: `Skip ${shortDate(o.date)} only. The rest of the series stays.`, reason: "Replaced by the new time below." },
        });
        ctx.items.push({
          action: "create_event",
          title: e.title,
          targetId: null,
          autoApply: commanded,
          commanded,
          payload,
          display: { ...EMPTY_DISPLAY, timing: timingFor(payload.startsAt as string, payload.endsAt as string, tz), reason: `Just ${shortDate(o.date)}. Every other ${e.title} stays as it is.`, editable: true },
        });
      } else {
        ctx.items.push({
          action: "update_event",
          title: e.title,
          targetId: e.id,
          autoApply: commanded,
          commanded,
          payload: {
            commitmentId: e.id,
            patch: { starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() },
            expect: { title: e.title, starts_at: e.startsAt, ends_at: e.endsAt, recurrence_rule: e.recurrenceRule ?? null },
            startsAt: newStart.toISOString(),
            endsAt: newEnd.toISOString(),
            timezone: e.timezone ?? tz,
          },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(newStart.toISOString(), newEnd.toISOString(), tz),
            previous: { start: e.startsAt!, end: e.endsAt! },
            detail: `${whenLabel(e.startsAt!, tz)} → ${whenLabel(newStart.toISOString(), tz)}`,
            reason: "Moved as you asked. Undo puts it back.",
          },
        });
      }
      ctx.excludeEventIds.add(e.id);
      ctx.extraEvents.push(asCommitment(e.id, { ...payload }));
      done.push(`${e.title} to ${whenLabel(newStart.toISOString(), tz)}`);
    }

    const verb = spec.mode === "clear" ? "Cleared" : "Moved";
    if (done.length) ctx.notes.push(`${verb} for ${period}${commanded ? " (already done, Undo on the card)" : " (on the card, waiting for Approve)"}: ${done.join("; ")}.`);
    const replanned = [...ctx.moves.values()].filter((m) => occurrences.some((o) => o.event.id === m.block.id)).length;
    if (replanned) ctx.notes.push(`${replanned} Whitespace session${replanned === 1 ? "" : "s"} ${spec.mode === "clear" ? "moved to other free times so the work still gets done" : "went to the nearest free time that day"}${commanded ? " (already done)" : ""}; the card shows when.`);
    if (google.length) ctx.notes.push(`${[...new Set(google)].join(", ")} ${new Set(google).size === 1 ? "comes" : "come"} from Google Calendar, so Whitespace left ${new Set(google).size === 1 ? "it" : "them"} as ${new Set(google).size === 1 ? "it is" : "they are"}. Say so, and that ${new Set(google).size === 1 ? "it" : "they"} can be changed in Google Calendar.`);
    if (repeating.length) ctx.notes.push(`${[...new Set(repeating)].join(", ")} ${new Set(repeating).size === 1 ? "repeats" : "repeat"} every week, so ${new Set(repeating).size === 1 ? "it" : "they"} stayed. Mention it in a few words; the user can name ${new Set(repeating).size === 1 ? "it" : "them"} to move ${new Set(repeating).size === 1 ? "it" : "them"} too.`);
  }

  function buildRecord(spec: ActionSpec, explicit: boolean, fromUser: boolean): void {
    const auto = explicit && AUTO_APPLY.has(spec.kind);
    /** The user directly told Whitespace to make exactly this calendar change: done now, with Undo. */
    const commanded = explicit && fromUser;
    switch (spec.kind) {
      case "event": {
        const startsAt = zonedToUtc(spec.date, spec.startTime, tz).toISOString();
        // An end earlier than the start runs past midnight, into the next day.
        const endsAt = zonedToUtc(spec.endTime > spec.startTime ? spec.date : addDaysToKey(spec.date, 1), spec.endTime, tz).toISOString();
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
          // "Add a study group Saturday 1-3": the user's own command is saved now, with Undo.
          // "I have a test Friday" (a statement) is Whitespace's suggestion and waits.
          autoApply: commanded,
          commanded,
          payload,
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(startsAt, endsAt, tz, { recurrence: spec.recurrenceText }),
            detail: spec.location ? `At ${spec.location}` : null,
            reason: [spec.recurrenceText ? `${spec.recurrenceText}, as you described.` : "As you described.", spec.assumed ?? null].filter(Boolean).join(" "),
            conflicts,
            tradeoffs: conflicts.map((c) => `Overlaps ${c.title} (${whenLabel(c.start, tz)}).`),
            editable: true,
          },
        });
        // Fixed events it collides with: Whitespace proposes which one gives way (Phase 7).
        // A one-time event over a repeating one: skip that day of the repeating one, on this
        // same card, so one approval settles it. Anything else is left as a recommendation.
        const occ = expandEvent(asEvent, now, new Date(now.getTime() + 28 * 86_400_000), tz);
        const fixedOthers = expandEvents(
          input.events.filter((e) => e.kind === "fixed" && !isFlexibleBlock(e)),
          now,
          new Date(now.getTime() + 28 * 86_400_000),
          tz,
        ).filter((o) => !o.allDay);
        const skipped = new Set<string>();
        for (const mineOcc of occ) {
          for (const other of overlapping(fixedOthers, mineOcc.start, mineOcc.end)) {
            const overlapMin = (Math.min(mineOcc.end.getTime(), other.end.getTime()) - Math.max(mineOcc.start.getTime(), other.start.getTime())) / 60_000;
            if (overlapMin < 10 || skipped.has(other.key)) continue;
            // A test during School is part of the school day, not a clash with it.
            if (other.recurring && containsDay(other, mineOcc)) continue;
            if (other.event.externalSource) {
              ctx.notes.push(`${spec.title} overlaps ${other.event.title} (${whenLabel(other.start.toISOString(), tz)}), which comes from Google Calendar, so Whitespace leaves it as it is. Mention the overlap in one line; if ${other.event.title} isn't happening, the user can change it in Google Calendar.`);
              continue;
            }
            if (spec.makeRoom && commanded && other.recurring && !spec.rrule) {
              // "Make room": the repeating thing in the way skips that day, as part of the command.
              skipped.add(other.key);
              ctx.items.push({
                action: "skip_occurrence",
                title: other.event.title,
                targetId: other.event.id,
                autoApply: true,
                commanded: true,
                payload: { commitmentId: other.event.id, date: other.date },
                display: { ...EMPTY_DISPLAY, detail: `Skip ${shortDate(other.date)} only. The rest of the series stays.`, reason: `Making room for ${spec.title}.` },
              });
              continue;
            }
            if (spec.makeRoom && !other.recurring) {
              ctx.notes.push(
                `${spec.title} overlaps ${other.event.title} (${whenLabel(other.start.toISOString(), tz)}), a one-time appointment. Whitespace doesn't move or cancel appointments on a guess: recommend a concrete fix (move ${other.event.title} to another time, or cancel it) and do it if the user says so.`,
              );
              continue;
            }
            const pick = pickKeeper(
              { id: "new", title: spec.title, recurring: !!spec.rrule },
              { id: other.event.id, title: other.event.title, recurring: other.recurring },
            );
            if (!pick) {
              ctx.notes.push(`${spec.title} overlaps ${other.event.title} (${whenLabel(other.start.toISOString(), tz)}). There's no clear choice: ask which one is happening.`);
              continue;
            }
            if (pick.keep.id === "new" && other.recurring) {
              skipped.add(other.key);
              ctx.items.push({
                action: "skip_occurrence",
                title: other.event.title,
                targetId: other.event.id,
                autoApply: false,
                payload: { commitmentId: other.event.id, date: other.date },
                display: {
                  ...EMPTY_DISPLAY,
                  detail: `Skip ${shortDate(other.date)} only. The rest of the series stays.`,
                  reason: `Overlaps ${spec.title}. ${pick.why}`,
                },
              });
              ctx.notes.push(`Whitespace proposes skipping ${other.event.title} on ${shortDate(other.date)} (it's on the card): ${pick.why} Say so in one line; the user can reject that item.`);
            } else {
              ctx.notes.push(
                `${spec.title} overlaps ${other.event.title} (${whenLabel(other.start.toISOString(), tz)}). Recommend keeping ${pick.keep.id === "new" ? spec.title : other.event.title}: ${pick.why} After saving, Home offers a one-tap fix.`,
              );
            }
          }
        }
        // An exam with nothing planned to study for it (7.3): study sessions before it, on this same card.
        if (!spec.rrule && isExam(spec.title)) {
          // Prep already exists: a task or session for the subject, or time asked for in this same message.
          const titles = [
            ...input.openTasks.map((t) => t.title),
            ...futureBlocks.map((b) => b.title),
            ...input.specs.flatMap((x) => (x.spec.kind === "plan_time" || x.spec.kind === "task_create" ? [x.spec.title] : [])),
          ];
          const a = getAnalysis();
          const prep = a && !hasPrep(spec.title, titles)
            ? examPrepPlan(
                { title: spec.title, startMs: Date.parse(startsAt) },
                { nowMs: now.getTime(), minSessionMinutes: input.preferences.minSessionMinutes, maxSessionMinutes: input.preferences.maxSessionMinutes, capacity: capacityBefore(a, Date.parse(startsAt)) },
              )
            : null;
          if (prep) {
            ctx.requests.push({
              id: `r${ctx.requests.length}`,
              title: prep.title.slice(0, 200),
              amount: { type: "sessions", count: prep.sessions, minutesEach: prep.minutesEach },
              priority: "high",
              deadline: startsAt,
              earliestStart: now.toISOString(),
              lifeAreaId: spec.lifeAreaId,
              taskId: null,
            });
            ctx.windows.push({ start: now, end: new Date(startsAt) });
            ctx.notes.push(`${spec.title} is an exam with nothing planned to study for it, so ${prep.sessions} study session${prep.sessions === 1 ? "" : "s"} before it are proposed on the card. Mention it in one line; the user can reject them.`);
          }
        }
        moveCollidingSessions(occ, commanded && !!spec.makeRoom);
        break;
      }
      case "event_update": {
        const e = spec.event;
        if (e.externalSource) {
          ctx.notes.push(`${e.title} comes from Google Calendar, so Whitespace can't change it. Tell the user to change it in Google Calendar; Whitespace picks it up on the next sync.`);
          break;
        }
        const etz = e.timezone ?? tz;
        const oldStart = new Date(e.startsAt!);
        const oldEnd = new Date(e.endsAt!);
        const c = spec.change;
        const baseDate = spec.scope === "one" && spec.occurrenceDate ? spec.occurrenceDate : dateKeyInZone(oldStart, etz);
        const date = c.date ?? baseDate;
        const startTime = c.startTime ?? timeKeyInZone(oldStart, etz);
        const endTime = c.endTime ?? timeKeyInZone(oldEnd, etz);
        const startsAt = zonedToUtc(date, startTime, etz).toISOString();
        let endsAt = zonedToUtc(date, endTime, etz).toISOString();
        if (Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = new Date(Date.parse(startsAt) + (oldEnd.getTime() - oldStart.getTime())).toISOString();
        const title = c.title ?? e.title;
        const rrule = c.rrule !== undefined ? c.rrule : e.recurrenceRule ?? null;
        const what = [
          c.title ? `Rename to "${c.title}"` : null,
          c.date || c.startTime || c.endTime ? `${whenLabel(spec.scope === "one" ? zonedToUtc(baseDate, timeKeyInZone(oldStart, etz), etz).toISOString() : e.startsAt!, etz)} → ${whenLabel(startsAt, etz)}` : null,
          c.rrule !== undefined ? (c.rrule ? c.recurrenceText ?? "Repeats" : "One time only") : null,
          c.location ? `At ${c.location}` : null,
        ].filter(Boolean);

        if (spec.scope === "one" && e.recurrenceRule && spec.occurrenceDate) {
          // One day of a repeating event: skip that day, add a one-time event with the change.
          ctx.items.push({
            action: "skip_occurrence",
            title: e.title,
            targetId: e.id,
            autoApply: commanded,
            commanded,
            payload: { commitmentId: e.id, date: spec.occurrenceDate },
            display: { ...EMPTY_DISPLAY, detail: `Skip ${shortDate(spec.occurrenceDate)} only. The rest of the series stays.`, reason: "Replaced by the changed time below." },
          });
          const payload: ItemPayload = {
            title,
            lifeAreaId: e.lifeAreaId ?? null,
            kind: "fixed",
            startsAt,
            endsAt,
            timezone: etz,
            rrule: null,
            location: c.location ?? e.location ?? null,
            notes: e.notes ?? null,
            sourceMessageId: input.sourceMessageId,
          };
          const asEvent = asCommitment(`new-${ctx.items.length}`, payload);
          const conflicts = eventConflicts(asEvent, input.events.filter((x) => x.id !== e.id), now, tz);
          ctx.extraEvents.push(asEvent);
          ctx.items.push({
            action: "create_event",
            title,
            targetId: null,
            autoApply: commanded,
            commanded,
            payload,
            display: {
              ...EMPTY_DISPLAY,
              timing: timingFor(startsAt, endsAt, etz),
              detail: what.join(" · ") || null,
              reason: `Just ${shortDate(spec.occurrenceDate)}. Every other ${e.title} stays as it is.`,
              conflicts,
              tradeoffs: conflicts.map((x) => `Overlaps ${x.title} (${whenLabel(x.start, tz)}).`),
              editable: true,
            },
          });
          moveCollidingSessions([{ start: new Date(startsAt), end: new Date(endsAt) }]);
          break;
        }

        const patch: Record<string, unknown> = {};
        if (c.title) patch.title = c.title;
        if (c.date || c.startTime || c.endTime) {
          patch.starts_at = startsAt;
          patch.ends_at = endsAt;
        }
        if (c.rrule !== undefined) patch.recurrence_rule = c.rrule;
        if (c.location !== undefined) patch.location = c.location;
        const moved = asCommitment(e.id, {
          title,
          startsAt: patch.starts_at ?? e.startsAt,
          endsAt: patch.ends_at ?? e.endsAt,
          rrule,
          timezone: etz,
        });
        const timeChanged = "starts_at" in patch || "recurrence_rule" in patch;
        const conflicts = timeChanged ? eventConflicts(moved, input.events.filter((x) => x.id !== e.id), now, tz) : [];
        const recurrence = rrule ? (parseRRule(rrule) ? describeRecurrence(parseRRule(rrule)!) : null) : null;
        ctx.items.push({
          action: "update_event",
          title: e.title,
          targetId: e.id,
          autoApply: commanded,
          commanded,
          payload: {
            commitmentId: e.id,
            patch,
            // What it looked like when suggested. If it changed since, approving refuses instead of overwriting.
            expect: { title: e.title, starts_at: e.startsAt, ends_at: e.endsAt, recurrence_rule: e.recurrenceRule ?? null },
            startsAt: String(patch.starts_at ?? e.startsAt),
            endsAt: String(patch.ends_at ?? e.endsAt),
            timezone: etz,
          },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(String(patch.starts_at ?? e.startsAt), String(patch.ends_at ?? e.endsAt), etz, { recurrence }),
            previous: "starts_at" in patch ? { start: e.startsAt!, end: e.endsAt! } : null,
            detail: what.join(" · ") || null,
            reason: "Only what you asked changes. Undo puts it back.",
            conflicts,
            tradeoffs: conflicts.map((x) => `Overlaps ${x.title} (${whenLabel(x.start, tz)}).`),
          },
        });
        if (timeChanged) {
          ctx.extraEvents.push(moved);
          ctx.excludeEventIds.add(e.id);
          moveCollidingSessions(expandEvent(moved, now, new Date(now.getTime() + 28 * 86_400_000), etz));
        }
        break;
      }
      case "task_create": {
        const dueAt = spec.dueDate ? zonedToUtc(spec.dueDate, spec.dueTime ?? "23:59", tz).toISOString() : null;
        // Priority leads: every task has one. A due date only shows when the user gave one.
        const detail = [`${spec.priority[0].toUpperCase()}${spec.priority.slice(1)} priority`, dueLabel(dueAt, tz), spec.estimatedMinutes ? minutesLabel(spec.estimatedMinutes) : null]
          .filter(Boolean)
          .join(" · ");
        // Reality check (7.3): does it fit before it's due? Then propose its sessions on the same card.
        const check = dueAt && spec.estimatedMinutes ? realityFor(spec.title, Date.parse(dueAt), spec.estimatedMinutes) : null;
        const plannedElsewhere = input.specs.some(
          (x) => x.spec.kind === "plan_time" && normalizeTitle(x.spec.title) === normalizeTitle(spec.title),
        );
        if (check) ctx.notes.push(check.note);
        if (check && dueAt && spec.estimatedMinutes && spec.estimatedMinutes >= MIN_NEW_TASK_SESSION && !plannedElsewhere) {
          const id = `r${ctx.requests.length}`;
          ctx.requests.push({
            id,
            title: spec.title,
            amount: { type: "total", minutes: spec.estimatedMinutes },
            priority: spec.priority,
            deadline: dueAt,
            earliestStart: now.toISOString(),
            lifeAreaId: spec.lifeAreaId,
            taskId: null,
          });
          ctx.windows.push({ start: now, end: new Date(dueAt) });
          newTaskRequests.add(id);
          ctx.notes.push(`Sessions for ${spec.title} are proposed on the card, before it's due. Present them as the recommended plan.`);
        }
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
          display: { ...EMPTY_DISPLAY, detail: detail || null, reason: "New task.", warnings: check?.warning ? [check.warning] : [] },
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
          // The user said it's done: check it off now, Undo on the card.
          // A proactive "did you finish this?" still waits for a tap.
          autoApply: fromUser,
          payload: { taskId: spec.task.id },
          display: { ...EMPTY_DISPLAY, detail: "Mark as done", reason: "You said it's finished." },
        });
        // Work sessions still ahead for it are no longer needed: freeing them is
        // Whitespace's suggestion (the user may still want the time), so it waits.
        const ahead = futureBlocks.filter((b) => b.taskId === spec.task.id);
        for (const b of ahead) {
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
              reason: `Work session for ${spec.task.title}, which is done.`,
            },
          });
        }
        if (ahead.length) ctx.notes.push(`${spec.task.title} still had ${ahead.length} work session${ahead.length === 1 ? "" : "s"} ahead. Freeing ${ahead.length === 1 ? "it is" : "them is"} suggested on the card; mention it in a few words.`);
        break;
      }
      case "task_remove": {
        ctx.items.push({
          action: "remove_task",
          title: spec.task.title,
          targetId: spec.task.id,
          // "Delete my essay task": done now, Undo brings it back.
          autoApply: explicit && fromUser,
          commanded: explicit && fromUser,
          payload: { taskId: spec.task.id },
          display: { ...EMPTY_DISPLAY, detail: "Delete this task", reason: "You asked to remove it. Undo brings it back." },
        });
        // Its work sessions go too, or they'd stay on the calendar with nothing to work on.
        // Part of the same command, so they go now as well (Undo brings them back).
        for (const b of futureBlocks.filter((b) => b.taskId === spec.task.id)) {
          ctx.items.push({
            action: "remove_block",
            title: b.title,
            targetId: b.id,
            autoApply: commanded,
            commanded,
            payload: { commitmentId: b.id },
            display: {
              ...EMPTY_DISPLAY,
              timing: timingFor(b.startsAt!, b.endsAt!, input.world.timeZone),
              detail: "Free up this time",
              reason: `Work session for ${spec.task.title}, which you're deleting.`,
            },
          });
        }
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
        // Planning a task again only books what's left of its estimate.
        let amount = spec.amount;
        const booked = task ? bookedByTask.get(task.id) ?? 0 : 0;
        if (task && booked > 0 && amount.type === "total" && amount.minutes === task.estimatedMinutes) {
          const left = Math.round(amount.minutes - booked);
          if (left < 15) {
            ctx.notes.push(`${task.title} already has its time booked.`);
            break;
          }
          amount = { type: "total", minutes: left };
        }
        const win = spec.onDate
          ? { start: new Date(Math.max(now.getTime(), startOfDayInZone(spec.onDate, tz).getTime())), end: startOfDayInZone(addDaysToKey(spec.onDate, 1), tz) }
          : windowFor(spec, input, deadline);
        ctx.windows.push(win);
        const requestId = `r${ctx.requests.length}`;
        ctx.requests.push({
          id: requestId,
          title: spec.title,
          amount,
          priority: spec.priority,
          deadline: (deadline && deadline <= win.end ? deadline : win.end).toISOString(),
          earliestStart: win.start.toISOString(),
          preferredDays: spec.preferredDays.length ? spec.preferredDays : undefined,
          lifeAreaId: spec.lifeAreaId,
          taskId: spec.taskId,
        });
        if (spec.makeRoom) makeRoomFor.add(requestId);
        break;
      }
      case "bulk_change": {
        bulkChange(spec, commanded);
        break;
      }
      case "remove_event": {
        ctx.adaptive = true;
        if (!spec.events.length) {
          ctx.notes.push(`Nothing called "${spec.title}" is on the calendar, so nothing was removed.`);
          break;
        }
        const fromGoogle = spec.events.filter((e) => e.externalSource);
        if (fromGoogle.length) {
          ctx.notes.push(`${fromGoogle.map((e) => e.title).join(", ")} ${fromGoogle.length === 1 ? "comes" : "come"} from Google Calendar, so Whitespace can't remove ${fromGoogle.length === 1 ? "it" : "them"}. Tell the user to delete or decline it in Google Calendar; Whitespace picks it up on the next sync.`);
        }
        for (const event of spec.events.filter((e) => !e.externalSource)) {
          const rule = parseRRule(event.recurrenceRule);
          const tz = event.timezone ?? input.world.timeZone;
          const time = event.startsAt && event.endsAt
            ? `${clockLabel(timeKeyInZone(new Date(event.startsAt), tz))}-${clockLabel(timeKeyInZone(new Date(event.endsAt), tz))}`
            : null;
          const when = rule ? describeRecurrence(rule) : event.startsAt ? shortDate(dateKeyInZone(new Date(event.startsAt), tz)) : null;
          ctx.items.push({
            action: "remove_event",
            title: event.title,
            targetId: event.id,
            // "Remove the dentist appointment": the user's own command happens now,
            // with Undo. Anything Whitespace suggests on its own waits for Approve.
            autoApply: explicit && fromUser,
            commanded: explicit && fromUser,
            payload: { commitmentId: event.id },
            display: {
              ...EMPTY_DISPLAY,
              detail: [when, time].filter(Boolean).join(", ") || null,
              reason: rule ? "You asked to remove it. Every repeat goes; Undo brings it back." : "You asked to remove it. Undo brings it back.",
            },
          });
        }
        break;
      }
      case "cant_make": {
        ctx.adaptive = true;
        if (spec.event?.externalSource) {
          ctx.notes.push(`${spec.event.title} comes from Google Calendar, so Whitespace can't skip or remove it. Tell the user to decline or delete it in Google Calendar; Whitespace picks it up on the next sync.`);
        } else if (spec.event && spec.event.kind === "fixed") {
          if (spec.event.recurrenceRule && spec.date) {
            ctx.items.push({
              action: "skip_occurrence",
              title: spec.event.title,
              targetId: spec.event.id,
              // "Cancel basketball tomorrow" / "skip piano today": the user's command, done now.
              autoApply: commanded,
              commanded,
              payload: { commitmentId: spec.event.id, date: spec.date },
              display: {
                ...EMPTY_DISPLAY,
                detail: `Skip ${shortDate(spec.date)} only. The rest of the series stays.`,
                reason: "You said you can't make it.",
              },
            });
          } else {
            // A one-time event they can't make: cancelling it is the obvious fix, proposed (or done when commanded).
            ctx.items.push({
              action: "remove_event",
              title: spec.event.title,
              targetId: spec.event.id,
              autoApply: commanded,
              commanded,
              payload: { commitmentId: spec.event.id },
              display: {
                ...EMPTY_DISPLAY,
                detail: spec.event.startsAt ? `${shortDate(dateKeyInZone(new Date(spec.event.startsAt), tz))}, ${clockLabel(timeKeyInZone(new Date(spec.event.startsAt), tz))}` : null,
                reason: "You said you can't make it. Undo brings it back.",
              },
            });
            if (!commanded) ctx.notes.push(`Whitespace proposes cancelling ${spec.event.title} (on the card). If they'd rather move it, they can say when.`);
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
            // Checked off right away; freeing its sessions still waits for Approve.
            autoApply: fromUser,
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
      case "remove_duplicates": {
        // A direct command with a clear rule: done now, Undo on the card.
        // "This week" is the whole week (past days included, they're what the user
        // is looking at); no period means everything loaded, from the week's start.
        const weekStart = startOfDayInZone(startOfWeekKey(input.world.todayKey, input.world.weekStartsOn), tz);
        const win =
          spec.window === "next_week" || spec.window === "today" || spec.window === "tomorrow"
            ? windowFor({ window: spec.window }, input, null)
            : spec.window === "this_week"
              ? { start: weekStart, end: new Date(weekStart.getTime() + 7 * 86_400_000 + 3 * 3_600_000) }
              : { start: weekStart, end: new Date(now.getTime() + MAX_WINDOW_DAYS * 86_400_000) };
        const range = `${shortDate(dateKeyInZone(win.start, tz))} to ${shortDate(dateKeyInZone(new Date(win.end.getTime() - 1), tz))}`;
        const cleanup = planCleanup(input.events, win.start, win.end, tz);
        if (!cleanup.length) {
          ctx.notes.push(`Checked every event from ${range} for duplicates (same slot as a Google Calendar event, or the same event twice): none found. Nothing was removed.`);
          break;
        }
        const lines: string[] = [];
        for (const c of cleanup) {
          if (c.kind === "series") {
            ctx.items.push({
              action: "remove_event",
              title: c.event.title,
              targetId: c.event.id,
              autoApply: fromUser,
              commanded: fromUser,
              payload: { commitmentId: c.event.id },
              display: {
                ...EMPTY_DISPLAY,
                detail: `Every repeat (${describeRecurrence(parseRRule(c.event.recurrenceRule)!)})`,
                reason: `All ${c.count} times it's on the calendar, Google Calendar already has it (${c.keptTitles.slice(0, 2).join(", ")}).`,
              },
            });
            lines.push(`${c.event.title}, the whole repeating series (Google has ${c.keptTitles[0]})`);
            continue;
          }
          const { keep, drop } = c.pair;
          const time = `${clockLabel(timeKeyInZone(drop.start, tz))}-${clockLabel(timeKeyInZone(drop.end, tz))}`;
          const why = `Same time as ${keep.event.title}${keep.event.externalSource ? " from Google Calendar" : ""}, which stays.`;
          ctx.items.push(
            drop.event.recurrenceRule
              ? {
                  action: "skip_occurrence",
                  title: drop.event.title,
                  targetId: drop.event.id,
                  autoApply: fromUser,
                  commanded: fromUser,
                  payload: { commitmentId: drop.event.id, date: drop.date },
                  display: { ...EMPTY_DISPLAY, detail: `${shortDate(drop.date)}, ${time} only. The rest of the series stays.`, reason: why },
                }
              : {
                  action: "remove_event",
                  title: drop.event.title,
                  targetId: drop.event.id,
                  autoApply: fromUser,
                  commanded: fromUser,
                  payload: { commitmentId: drop.event.id },
                  display: { ...EMPTY_DISPLAY, detail: `${shortDate(drop.date)}, ${time}`, reason: why },
                },
          );
          lines.push(`${drop.event.title} on ${shortDate(drop.date)} (kept ${keep.event.title})`);
        }
        ctx.notes.push(`Checked every event from ${range}. Removed ${lines.length} duplicate${lines.length === 1 ? "" : "s"}, keeping the Google Calendar copy each time: ${lines.join("; ")}. Undo is on the card.`);
        break;
      }
      case "not_enough_time": {
        ctx.adaptive = true;
        // "I'm behind" (7.5): one recovery plan for overdue work and the next week,
        // most urgent first; what can't fit is left out on purpose, with why.
        const a = spec.window !== "next_week" ? getAnalysis() : null;
        if (a) {
          const plan = catchUpPlan(a);
          const noEstimate = input.openTasks.filter((t) => !t.estimatedMinutes && t.dueAt && Date.parse(t.dueAt) < now.getTime() + 7 * 86_400_000 && !t.parentTaskId);
          for (const k of plan.keep) {
            const left = Math.min(k.minutes, (k.t.task.estimatedMinutes ?? 0) - (bookedByTask.get(k.t.task.id) ?? 0));
            if (left < 15) continue;
            ctx.requests.push({
              id: `r${ctx.requests.length}`,
              title: k.t.task.title,
              amount: { type: "total", minutes: Math.round(left) },
              priority: k.t.task.priority,
              deadline: new Date(k.deadlineMs).toISOString(),
              earliestStart: now.toISOString(),
              lifeAreaId: k.t.task.lifeAreaId ?? null,
              taskId: k.t.task.id,
            });
            ctx.windows.push({ start: now, end: new Date(k.deadlineMs) });
          }
          for (const l of plan.leftOut) ctx.unscheduled.push({ title: l.title, minutes: 0, reason: l.reason });
          ctx.notes.push(plan.summary);
          if (noEstimate.length) ctx.notes.push(`These tasks have no time estimate, so they were not counted: ${noEstimate.slice(0, 5).map((t) => t.title).join(", ")}.`);
          break;
        }
        const win = windowFor({ window: spec.window }, input, null);
        ctx.windows.push(win);
        const noEstimate: string[] = [];
        const withSteps = new Set(input.openTasks.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!));
        for (const task of input.openTasks) {
          if (task.dueAt && Date.parse(task.dueAt) > win.end.getTime() + 7 * 86_400_000) continue;
          if (withSteps.has(task.id)) continue; // its steps carry the work
          const req = requestFromTask(task);
          if (!req) {
            if (task.dueAt) noEstimate.push(task.title);
            continue;
          }
          const left = (req.amount.type === "total" ? req.amount.minutes : 0) - (bookedByTask.get(task.id) ?? 0);
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

    const run = (preferences: SchedulingPreferences = input.preferences) =>
      planSchedule({
        now: input.now,
        timeZone: tz,
        window: window!,
        events: [...input.events.filter((e) => !ctx.excludeEventIds.has(e.id)), ...ctx.extraEvents],
        busy: [...input.busy, ...ctx.extraBusy],
        preferences,
        requests: ctx.requests,
      });
    let result = run();
    const isShort = (x: typeof result) => ctx.requests.some((r) => makeRoomFor.has(r.id) && x.outcomes.some((o) => o.requestId === r.id && o.status !== "scheduled"));
    // "Make room" overrides the usual daily limit on new work: the user asked for this time.
    const relaxed: SchedulingPreferences = { ...input.preferences, dailyCapMinutes: 720, keepFreePercent: 0 };
    if (isShort(result)) {
      const again = run(relaxed);
      if (!isShort(again)) {
        result = again;
        ctx.notes.push("This goes past the usual daily limit on new work, because the user asked to make room. Mention it'll be a full day.");
      }
    }

    // "Make room": when the time doesn't fit, lower-priority sessions in that period
    // move out of the way (on the same card), and the engine places everything again.
    // Equal or more important work is never pushed aside.
    const short = ctx.requests.filter((r) => makeRoomFor.has(r.id) && result.outcomes.some((o) => o.requestId === r.id && o.status !== "scheduled"));
    if (short.length) {
      const victims: string[] = [];
      const blockers: string[] = [];
      for (const r of short) {
        const from = Date.parse(r.earliestStart ?? input.now);
        const to = Date.parse(r.deadline ?? window.end);
        for (const b of futureBlocks) {
          if (ctx.excludeEventIds.has(b.id)) continue;
          if (Date.parse(b.endsAt!) <= from || Date.parse(b.startsAt!) >= to) continue;
          const task = b.taskId ? tasksById.get(b.taskId) ?? null : null;
          const rank = PRIORITY_RANK[task?.priority ?? "medium"];
          if (rank >= PRIORITY_RANK[r.priority ?? "medium"]) {
            blockers.push(b.title);
            continue;
          }
          moveRequest(b, ctx, input, null, task, { avoid: [{ start: new Date(from).toISOString(), end: new Date(to).toISOString() }] });
          victims.push(b.title);
        }
      }
      if (victims.length) {
        const before = { result, window, requests: ctx.requests.length };
        const end2 = new Date(Math.min(Math.max(...ctx.windows.map((w) => w.end.getTime())), now.getTime() + MAX_WINDOW_DAYS * 86_400_000));
        if (end2.getTime() > Date.parse(window.end)) window = { start: window.start, end: end2.toISOString() };
        result = run(relaxed);
        const helped = short.some((r) => {
          const placed = (x: typeof result) => x.sessions.filter((v) => v.requestId === r.id).length;
          return placed(result) > placed(before.result);
        });
        if (helped) {
          ctx.notes.push(`To make room, lower-priority ${victims.length === 1 ? "session" : "sessions"} (${[...new Set(victims)].join(", ")}) ${victims.length === 1 ? "moves" : "move"} to another time on the same card. Say so in one line.`);
        } else {
          // Moving them wouldn't have made it fit: leave them where they are.
          for (const r of ctx.requests.splice(before.requests)) {
            const m = ctx.moves.get(r.id);
            if (m) ctx.excludeEventIds.delete(m.block.id);
            ctx.moves.delete(r.id);
          }
          result = before.result;
          window = before.window;
          victims.length = 0;
        }
      }
      if (blockers.length) {
        const stillShort = short.some((r) => result.outcomes.some((o) => o.requestId === r.id && o.status !== "scheduled"));
        if (stillShort) ctx.notes.push(`Only equally or more important work is in the way (${[...new Set(blockers)].join(", ")}), so Whitespace didn't move it. Say what didn't fit and recommend one concrete trade-off for the user to choose.`);
      }
      if (!victims.length && !blockers.length) ctx.notes.push("Nothing Whitespace scheduled is in the way: the time is taken by fixed events. Say what didn't fit.");
    }
    summary = result.summary;
    const byId = new Map(ctx.requests.map((r) => [r.id, r]));
    const numbers = sessionNumbers(result.sessions);

    for (const s of result.sessions) {
      const move = ctx.moves.get(s.requestId);
      const request = byId.get(s.requestId)!;
      if (move) {
        ctx.items.push({
          action: "move_block",
          title: move.block.title,
          targetId: move.block.id,
          autoApply: !!move.commanded,
          commanded: !!move.commanded,
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
            ...sessionVisuals(s, null),
          },
        });
      } else {
        const linked = request.taskId ? tasksById.get(request.taskId) : undefined;
        ctx.items.push(blockItem(s, numbers.get(s.id), request, tz, input.sourceMessageId, stepInfo(linked, input.openTasks)));
        if (newTaskRequests.has(s.requestId)) ctx.items[ctx.items.length - 1].payload.forNewTask = true;
      }
      ctx.items[ctx.items.length - 1].actionId = requestAction.get(s.requestId) ?? null;
    }

    for (const outcome of result.outcomes) {
      if (outcome.status === "scheduled") continue;
      const move = ctx.moves.get(outcome.requestId);
      if (move?.keepIfNoRoom) {
        // A move the user asked for that has no free time there: the session stays where it is.
        ctx.notes.push(`${move.block.title} (${whenLabel(move.block.startsAt!, tz)}) has no free time on the new day, so it stayed where it is. Say so and offer another day.`);
        continue;
      }
      if (move && outcome.status === "unscheduled") {
        ctx.items.push({
          action: "remove_block",
          title: move.block.title,
          targetId: move.block.id,
          autoApply: !!move.commanded,
          commanded: !!move.commanded,
          payload: { commitmentId: move.block.id },
          display: {
            ...EMPTY_DISPLAY,
            timing: timingFor(move.block.startsAt!, move.block.endsAt!, tz),
            detail: "Remove this session",
            reason: move.commanded ? "No other free time fits before it's due, so it was taken off." : "You can't make it, and no other time fits before it's due.",
            tradeoffs: [outcome.issue?.message ?? "No free time left."],
          },
        });
        ctx.items[ctx.items.length - 1].actionId = requestAction.get(outcome.requestId) ?? null;
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
    items: withoutDuplicates(ctx.items),
    summary,
    unscheduled: ctx.unscheduled,
    notes: ctx.notes,
    context: { requests: ctx.requests, window },
  };
}

/** The same change to the same record only once ("Delete task: Outline the Essay" four times). */
function withoutDuplicates<T extends { action: string; targetId: string | null; payload: unknown }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (!i.targetId) return true;
    const key = `${i.action}:${i.targetId}:${JSON.stringify(i.payload)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
