import { normalizeText } from "@/lib/ai/extraction";
import type { Clarify, ClarifyField } from "@/features/assistant/plan-types";
import type { Commitment, ContextAttributes, Goal, Habit, HabitCadence, LifeAreaRecord, Task, Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import { addMinutesToTime, firstMatchingDay, hasDateRef, minutesBetweenTimes, resolveDateRef, weekdayName, weekdayOf } from "./dates";
import type { Intent, PlanWindow } from "./intents";

/**
 * Decides, for each intent, whether Whitespace has everything it needs or
 * which single question to ask next. Never guesses a missing day, time,
 * duration or amount: those become questions. Pure, unit tested.
 */

/** Short refs the planner sees for existing records (t1, e2, b3, h1, g4). */
export type RefTable = {
  tasks: Map<string, Task>;
  events: Map<string, Commitment>;
  /** Sessions the assistant scheduled earlier (flexible, plan_item_id set). */
  blocks: Map<string, Commitment>;
  habits: Map<string, Habit>;
  goals: Map<string, Goal>;
};

export type World = {
  todayKey: string;
  timeZone: string;
  weekStartsOn: 0 | 1;
  areas: LifeAreaRecord[];
  refs: RefTable;
};

export type ActionSpec =
  | {
      kind: "event";
      title: string;
      lifeAreaId: string | null;
      /** First occurrence, local. */
      date: string;
      startTime: string;
      endTime: string;
      /** RRULE or null for one time. */
      rrule: string | null;
      recurrenceText: string | null;
      location: string | null;
      notes: string | null;
    }
  | {
      kind: "task_create";
      title: string;
      lifeAreaId: string | null;
      dueDate: string | null;
      dueTime: string | null;
      estimatedMinutes: number | null;
      priority: "high" | "medium" | "low";
      description: string | null;
    }
  | {
      kind: "task_update";
      task: Task;
      patch: {
        title?: string;
        priority?: "high" | "medium" | "low";
        dueDate?: string;
        dueTime?: string | null;
        estimatedMinutes?: number;
      };
    }
  | { kind: "task_complete"; task: Task }
  | { kind: "task_remove"; task: Task }
  | { kind: "habit_create"; title: string; lifeAreaId: string | null; cadence: HabitCadence }
  | { kind: "habit_update"; habit: Habit; cadence: HabitCadence }
  | { kind: "goal_create"; title: string; lifeAreaId: string | null; targetDate: string | null; description: string | null }
  | { kind: "goal_update"; goal: Goal; progress: number | null; targetDate: string | null }
  | {
      kind: "set_area";
      table: "commitments" | "tasks" | "habits" | "goals";
      id: string;
      title: string;
      lifeAreaId: string | null;
      areaName: string;
    }
  | {
      kind: "prefs";
      dayStart: string | null;
      dayEnd: string | null;
      maxSessionMinutes: number | null;
      bufferMinutes: number | null;
      protectedTime: { label: string; days: Weekday[]; start: string; end: string } | null;
    }
  | {
      kind: "fact";
      category: "activity" | "interest" | "routine" | "working_time" | "preference";
      title: string;
      details: string | null;
      lifeAreaId: string | null;
      attributes: ContextAttributes;
    }
  | {
      kind: "plan_time";
      title: string;
      amount:
        | { type: "single"; minutes: number }
        | { type: "total"; minutes: number }
        | { type: "sessions"; count: number; minutesEach: number };
      priority: "high" | "medium" | "low";
      /** Local date + optional time the work must be done by. */
      deadlineDate: string | null;
      deadlineTime: string | null;
      window: PlanWindow;
      preferredDays: Weekday[];
      taskId: string | null;
      lifeAreaId: string | null;
    }
  | { kind: "cant_make"; date: string | null; blocks: Commitment[]; event: Commitment | null; title: string }
  /** Every matching event goes (a repeating event goes as a whole series). Empty when nothing matched. */
  | { kind: "remove_event"; events: Commitment[]; title: string }
  | { kind: "finished_early"; task: Task | null; title: string }
  | { kind: "not_enough_time"; window: PlanWindow };

export type Assessment =
  | { status: "ready"; spec: ActionSpec; intent: Intent }
  | { status: "needs"; clarify: Clarify; intent: Intent }
  | { status: "skip"; reason: string; intent: Intent };

const DURATION_CHOICES = ["1 hour", "90 minutes", "2 hours"];

function lifeAreaId(world: World, name: string | null): string | null {
  if (!name) return null;
  const n = normalizeText(name);
  const exact = world.areas.find((a) => normalizeText(a.name) === n);
  if (exact) return exact.id;
  const partial = world.areas.find((a) => normalizeText(a.name).includes(n) || n.includes(normalizeText(a.name)));
  return partial?.id ?? null;
}

function needs(intent: Intent, field: ClarifyField, about: string, question: string, choices: string[] = []): Assessment {
  return { status: "needs", intent, clarify: { field, about, question, choices } };
}

function label(intent: Intent, fallback: string): string {
  return intent.title ?? fallback;
}

function lower(title: string): string {
  // "Volleyball" -> "volleyball" for mid-sentence use, but keep acronyms ("SAT prep").
  return /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title;
}

/** Finds a record by ref, or by title when the model gave no ref. */
function findByRef<T extends { title: string }>(map: Map<string, T>, ref: string | null, title: string | null): T | null {
  if (ref && map.has(ref)) return map.get(ref)!;
  if (!title) return null;
  const n = normalizeText(title);
  const matches = [...map.values()].filter((v) => {
    const t = normalizeText(v.title);
    return t === n || t.includes(n) || n.includes(t);
  });
  return matches.length === 1 ? matches[0] : null;
}

function candidates<T extends { title: string }>(map: Map<string, T>, title: string | null): string[] {
  const all = [...map.values()];
  if (!title) return all.slice(0, 3).map((v) => v.title);
  const words = normalizeText(title).split(" ").filter((w) => w.length > 2);
  return all
    .filter((v) => words.some((w) => normalizeText(v.title).includes(w)))
    .slice(0, 3)
    .map((v) => v.title);
}

function eventTimes(intent: Intent): { start: string; end: string } | { missing: "time" | "duration" } {
  if (!intent.startTime) return { missing: "time" };
  if (intent.endTime) {
    if (minutesBetweenTimes(intent.startTime, intent.endTime) <= 0) return { missing: "duration" };
    return { start: intent.startTime, end: intent.endTime };
  }
  if (intent.durationMinutes) {
    const end = addMinutesToTime(intent.startTime, intent.durationMinutes);
    if (!end) return { missing: "duration" };
    return { start: intent.startTime, end };
  }
  return { missing: "duration" };
}

const RRULE_DAY: Record<Weekday, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };

function recurrenceFor(intent: Intent, firstDate: string): { rrule: string | null; text: string | null } {
  switch (intent.recurrence) {
    case "daily":
      return { rrule: "FREQ=DAILY", text: "Every day" };
    case "weekdays":
      return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", text: "Every weekday" };
    case "weekly": {
      const days = intent.days.length ? intent.days : [weekdayOf(firstDate)];
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${days.map((d) => RRULE_DAY[d]).join(",")}`,
        text: `Every ${days.map((d) => weekdayName(d)).join(" and ")}`,
      };
    }
    default:
      return { rrule: null, text: null };
  }
}

function assessEvent(intent: Intent, world: World): Assessment {
  const title = label(intent, "this");
  if (!intent.title) return needs(intent, "other", "Event", "What should I call it?");

  // Which day(s). Recurring events can be anchored by their days alone.
  const recurringDays = intent.recurrence === "weekly" ? intent.days : [];
  let date = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
  if (!date && intent.recurrence === "weekdays") date = firstMatchingDay(world.todayKey, ["mo", "tu", "we", "th", "fr"]);
  if (!date && intent.recurrence === "daily") date = world.todayKey;
  if (!date && recurringDays.length) date = firstMatchingDay(world.todayKey, recurringDays);
  if (!date && !hasDateRef(intent.date) && intent.days.length) date = firstMatchingDay(world.todayKey, intent.days);
  if (!date) return needs(intent, "date", title, `What day is ${lower(title)}?`);

  // One time or repeating. Only ask when it reads like a routine (weekday given, no calendar date).
  if (intent.recurrence === null) {
    const looksRoutine = !!intent.date?.weekday && !intent.date.isoDate && intent.date.week === null;
    if (looksRoutine || intent.days.length) {
      const day = weekdayName(intent.days[0] ?? weekdayOf(date));
      return needs(intent, "recurrence", title, `Is that every ${day} or just this ${day}?`, [
        `Every ${day}`,
        "Just this week",
      ]);
    }
  }

  const times = eventTimes(intent);
  if ("missing" in times) {
    if (times.missing === "time") return needs(intent, "time", title, `What time does ${lower(title)} start?`);
    return needs(intent, "duration", title, `How long does ${lower(title)} usually last?`, DURATION_CHOICES);
  }

  const rec = recurrenceFor(intent, date);
  return {
    status: "ready",
    intent,
    spec: {
      kind: "event",
      title: intent.title,
      lifeAreaId: lifeAreaId(world, intent.area),
      date,
      startTime: times.start,
      endTime: times.end,
      rrule: rec.rrule,
      recurrenceText: rec.text,
      location: intent.location,
      notes: intent.details,
    },
  };
}

function cadenceOf(intent: Intent): HabitCadence | null {
  if (intent.cadence === "daily") return { type: "daily" };
  if (intent.cadence === "specific_days" && intent.days.length) return { type: "specific_days", days: intent.days };
  if (intent.cadence === "weekly" && intent.timesPerWeek) return { type: "weekly", timesPerWeek: intent.timesPerWeek };
  if (!intent.cadence && intent.timesPerWeek) return { type: "weekly", timesPerWeek: intent.timesPerWeek };
  if (!intent.cadence && intent.days.length) return { type: "specific_days", days: intent.days };
  return null;
}

export type PlanAmount = Extract<ActionSpec, { kind: "plan_time" }>["amount"];

function planAmount(intent: Intent): PlanAmount | null {
  if (intent.amountKind === "sessions" || (intent.sessionCount && !intent.amountKind)) {
    if (!intent.sessionCount) return null;
    const each = intent.sessionMinutes ?? (intent.amountMinutes ? Math.round(intent.amountMinutes / intent.sessionCount) : null);
    if (!each) return null;
    return { type: "sessions", count: intent.sessionCount, minutesEach: each };
  }
  if (!intent.amountMinutes) return null;
  return intent.amountKind === "single"
    ? { type: "single", minutes: intent.amountMinutes }
    : { type: "total", minutes: intent.amountMinutes };
}

function assessPlanTime(intent: Intent, world: World): Assessment {
  const task = findByRef(world.refs.tasks, intent.targetRef, null);
  const title = intent.title ?? task?.title ?? null;
  if (!title) return needs(intent, "other", "Planning", "What would you like me to find time for?");

  let amount = planAmount(intent);
  if (!amount && task?.estimatedMinutes) amount = { type: "total", minutes: task.estimatedMinutes };
  if (!amount) {
    if (intent.sessionCount && !intent.sessionMinutes) {
      return needs(intent, "duration", title, `How long should each ${lower(title)} session be?`, ["30 minutes", "45 minutes", "1 hour"]);
    }
    return needs(intent, "amount", title, `About how much time do you need for ${lower(title)}?`, ["1 hour", "2 hours", "3 hours"]);
  }

  const deadlineDate = resolveDateRef(intent.deadline, world.todayKey, world.weekStartsOn);
  let deadlineTime = intent.deadlineTime;
  if (deadlineDate && deadlineDate < world.todayKey) {
    return needs(intent, "deadline", title, `That date has passed. When is ${lower(title)} due?`);
  }
  if (!deadlineDate) deadlineTime = null;

  const window: PlanWindow =
    intent.window ?? (deadlineDate || task?.dueAt ? "until_deadline" : "this_week");

  return {
    status: "ready",
    intent,
    spec: {
      kind: "plan_time",
      title,
      amount,
      priority: intent.priority ?? task?.priority ?? "medium",
      deadlineDate,
      deadlineTime,
      window,
      preferredDays: intent.days,
      taskId: task?.id ?? null,
      lifeAreaId: lifeAreaId(world, intent.area) ?? task?.lifeAreaId ?? null,
    },
  };
}

export function assessIntent(intent: Intent, world: World): Assessment {
  const { refs } = world;
  switch (intent.type) {
    case "create_event":
      return assessEvent(intent, world);

    case "create_task": {
      if (!intent.title) return needs(intent, "other", "Task", "What's the task?");
      const dueDate = resolveDateRef(intent.deadline ?? intent.date, world.todayKey, world.weekStartsOn);
      return {
        status: "ready",
        intent,
        spec: {
          kind: "task_create",
          title: intent.title,
          lifeAreaId: lifeAreaId(world, intent.area),
          dueDate,
          dueTime: dueDate ? intent.deadlineTime : null,
          estimatedMinutes: intent.amountMinutes ?? intent.durationMinutes,
          priority: intent.priority ?? "medium",
          description: intent.details,
        },
      };
    }

    case "update_task":
    case "complete_task":
    case "remove_task": {
      const task = findByRef(refs.tasks, intent.targetRef, intent.title);
      if (!task) {
        const options = candidates(refs.tasks, intent.title);
        return needs(intent, "target", intent.title ?? "Task", "Which task do you mean?", options);
      }
      if (intent.type === "complete_task") return { status: "ready", intent, spec: { kind: "task_complete", task } };
      if (intent.type === "remove_task") return { status: "ready", intent, spec: { kind: "task_remove", task } };
      const patch: Extract<ActionSpec, { kind: "task_update" }>["patch"] = {};
      const due = resolveDateRef(intent.deadline ?? intent.date, world.todayKey, world.weekStartsOn);
      if (due) {
        patch.dueDate = due;
        patch.dueTime = intent.deadlineTime;
      }
      if (intent.priority) patch.priority = intent.priority;
      const minutes = intent.amountMinutes ?? intent.durationMinutes;
      if (minutes) patch.estimatedMinutes = minutes;
      if (!Object.keys(patch).length) {
        return needs(intent, "other", task.title, `What should I change about ${lower(task.title)}?`);
      }
      return { status: "ready", intent, spec: { kind: "task_update", task, patch } };
    }

    case "create_habit": {
      if (!intent.title) return needs(intent, "other", "Habit", "What habit do you want to build?");
      const cadence = cadenceOf(intent);
      if (!cadence) {
        return needs(intent, "amount", intent.title, `How often do you want to ${lower(intent.title)}?`, [
          "Every day",
          "3 times a week",
          "Twice a week",
        ]);
      }
      return { status: "ready", intent, spec: { kind: "habit_create", title: intent.title, lifeAreaId: lifeAreaId(world, intent.area), cadence } };
    }

    case "update_habit": {
      const habit = findByRef(refs.habits, intent.targetRef, intent.title);
      if (!habit) return needs(intent, "target", intent.title ?? "Habit", "Which habit do you mean?", candidates(refs.habits, intent.title));
      const cadence = cadenceOf(intent);
      if (!cadence) return needs(intent, "amount", habit.title, `How often should ${lower(habit.title)} be?`, ["Every day", "3 times a week"]);
      return { status: "ready", intent, spec: { kind: "habit_update", habit, cadence } };
    }

    case "create_goal": {
      if (!intent.title) return needs(intent, "other", "Goal", "What's the goal?");
      return {
        status: "ready",
        intent,
        spec: {
          kind: "goal_create",
          title: intent.title,
          lifeAreaId: lifeAreaId(world, intent.area),
          targetDate: resolveDateRef(intent.targetDate ?? intent.deadline, world.todayKey, world.weekStartsOn),
          description: intent.details,
        },
      };
    }

    case "update_goal": {
      const goal = findByRef(refs.goals, intent.targetRef, intent.title);
      if (!goal) return needs(intent, "target", intent.title ?? "Goal", "Which goal do you mean?", candidates(refs.goals, intent.title));
      const targetDate = resolveDateRef(intent.targetDate ?? intent.deadline, world.todayKey, world.weekStartsOn);
      if (intent.progress === null && !targetDate) {
        return needs(intent, "amount", goal.title, `Roughly how far along is ${lower(goal.title)}, as a percent?`, ["25%", "50%", "75%"]);
      }
      return { status: "ready", intent, spec: { kind: "goal_update", goal, progress: intent.progress, targetDate } };
    }

    case "set_life_area": {
      const areaId = lifeAreaId(world, intent.area);
      if (!areaId) {
        return needs(intent, "other", intent.title ?? "Life area", "Which life area should it go in?", world.areas.slice(0, 4).map((a) => a.name));
      }
      const areaName = world.areas.find((a) => a.id === areaId)!.name;
      const ref = intent.targetRef ?? "";
      const lookup: [Map<string, { id: string; title: string }>, "tasks" | "commitments" | "habits" | "goals"][] = [
        [refs.tasks, "tasks"],
        [refs.events, "commitments"],
        [refs.blocks, "commitments"],
        [refs.habits, "habits"],
        [refs.goals, "goals"],
      ];
      for (const [map, table] of lookup) {
        const found = findByRef(map, ref || null, ref ? null : intent.title);
        if (found) return { status: "ready", intent, spec: { kind: "set_area", table, id: found.id, title: found.title, lifeAreaId: areaId, areaName } };
      }
      return needs(intent, "target", intent.title ?? "Item", "Which item should I move?");
    }

    case "update_preferences": {
      const p = intent.prefs;
      const protectedTime =
        p.protectedLabel && intent.startTime && intent.endTime
          ? { label: p.protectedLabel, days: intent.days.length ? intent.days : [...WEEKDAYS], start: intent.startTime, end: intent.endTime }
          : null;
      if (p.protectedLabel && !protectedTime) {
        return needs(intent, "time", p.protectedLabel, `What time should I keep free for ${lower(p.protectedLabel)}?`);
      }
      if (!p.dayStart && !p.dayEnd && !p.maxSessionMinutes && p.bufferMinutes === null && !protectedTime) {
        return { status: "skip", intent, reason: "No preference change found." };
      }
      return {
        status: "ready",
        intent,
        spec: {
          kind: "prefs",
          dayStart: p.dayStart,
          dayEnd: p.dayEnd,
          maxSessionMinutes: p.maxSessionMinutes,
          bufferMinutes: p.bufferMinutes,
          protectedTime,
        },
      };
    }

    case "save_fact": {
      if (!intent.title || !intent.factCategory) return { status: "skip", intent, reason: "Incomplete fact." };
      const attributes: ContextAttributes = {};
      if (intent.days.length) attributes.days = intent.days;
      if (intent.startTime) attributes.startTime = intent.startTime;
      if (intent.endTime) attributes.endTime = intent.endTime;
      if (intent.timesPerWeek) attributes.timesPerWeek = intent.timesPerWeek;
      if (intent.durationMinutes) attributes.durationMinutes = intent.durationMinutes;
      return {
        status: "ready",
        intent,
        spec: {
          kind: "fact",
          category: intent.factCategory,
          title: intent.title,
          details: intent.details,
          lifeAreaId: lifeAreaId(world, intent.area),
          attributes,
        },
      };
    }

    case "plan_time":
      return assessPlanTime(intent, world);

    case "remove_event": {
      const byRef = intent.targetRef ? refs.events.get(intent.targetRef) ?? refs.blocks.get(intent.targetRef) ?? null : null;
      const title = intent.title ?? byRef?.title ?? null;
      if (byRef) return { status: "ready", intent, spec: { kind: "remove_event", events: [byRef], title: byRef.title } };
      if (!title) {
        return needs(intent, "target", "Event", "Which event should I remove?", [...refs.events.values()].slice(0, 3).map((e) => e.title));
      }
      const matches = matchEvents([...refs.events.values(), ...refs.blocks.values()], title);
      // Tasks aren't on the calendar. If only a task matches, the user meant that.
      if (!matches.length) {
        const task = findByRef(refs.tasks, null, title);
        if (task) return { status: "ready", intent, spec: { kind: "task_remove", task } };
      }
      const names = [...new Set(matches.map((m) => m.title))];
      const distinct = new Set(matches.map((m) => normalizeText(m.title)));
      if (distinct.size > 1) return needs(intent, "target", title, "Which one should I remove?", names.slice(0, 4));
      return { status: "ready", intent, spec: { kind: "remove_event", events: matches, title: matches[0]?.title ?? title } };
    }

    case "cant_make": {
      const date = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
      const block = intent.targetRef ? refs.blocks.get(intent.targetRef) ?? null : null;
      const event = intent.targetRef ? refs.events.get(intent.targetRef) ?? null : null;
      const title = intent.title ?? block?.title ?? event?.title ?? "that";
      if (!date && !block && !event) return needs(intent, "date", title, `Which day can't you make ${lower(title)}?`);
      // Sessions on that day whose title matches (or every session that day when no title was given).
      const n = intent.title ? normalizeText(intent.title) : null;
      const blocks = block
        ? [block]
        : [...refs.blocks.values()].filter((b) => {
            if (!b.startsAt) return false;
            const sameDay = date ? b.startsAt && localDate(b.startsAt, world.timeZone) === date : true;
            const matchesTitle = !n || n.split(" ").some((w) => w.length > 2 && normalizeText(b.title).includes(w));
            return sameDay && matchesTitle;
          });
      return { status: "ready", intent, spec: { kind: "cant_make", date, blocks, event, title } };
    }

    case "finished_early": {
      const task = findByRef(refs.tasks, intent.targetRef, intent.title);
      if (!task && !intent.title) return needs(intent, "target", "Task", "What did you finish?", candidates(refs.tasks, null));
      return { status: "ready", intent, spec: { kind: "finished_early", task, title: task?.title ?? intent.title! } };
    }

    case "not_enough_time":
      return { status: "ready", intent, spec: { kind: "not_enough_time", window: intent.window ?? "this_week" } };

    case "cancel_draft":
      return { status: "skip", intent, reason: "Cancelled." };
  }
}

/** Events whose title matches: exact first, else containment, else shared words. */
function matchEvents(events: Commitment[], title: string): Commitment[] {
  const n = normalizeText(title);
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const exact = unique.filter((e) => normalizeText(e.title) === n);
  if (exact.length) return exact;
  const contains = unique.filter((e) => {
    const t = normalizeText(e.title);
    return t.includes(n) || n.includes(t);
  });
  if (contains.length) return contains;
  const words = n.split(" ").filter((w) => w.length > 3);
  return words.length ? unique.filter((e) => words.every((w) => normalizeText(e.title).includes(w))) : [];
}

function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
