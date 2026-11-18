import { isScheduledOn } from "@/lib/domain/habits";
import type { Commitment, Habit, Task } from "@/lib/domain/types";
import { clockLabel } from "@/lib/assistant/dates";
import { findFreeTime, type SchedulingPreferences } from "@/lib/scheduling/planner";
import { describeRecurrence, expandEvents, parseRRule } from "@/lib/scheduling/recurrence";
import { addDaysToKey, daysBetweenKeys, startOfDayInZone, timeKeyInZone } from "@/lib/scheduling/zoned";
import type { CheckIn, CheckInKind } from "../plan-types";

/**
 * Pure check-in builder: real events, deadlines, habits and free time for a
 * day or a week. Starters are built only from what exists. Unit tested.
 */
export function buildCheckIn(input: {
  kind: CheckInKind;
  now: Date;
  timeZone: string;
  /** Local dates, inclusive. */
  from: string;
  to: string;
  events: Commitment[];
  openTasks: Task[];
  habits: Habit[];
  preferences: SchedulingPreferences;
}): CheckIn {
  const tz = input.timeZone;
  const start = startOfDayInZone(input.from, tz);
  const end = startOfDayInZone(addDaysToKey(input.to, 1), tz);
  const occurrences = expandEvents(input.events, start, end, tz);

  const events = occurrences.map((o) => ({
    id: o.event.id,
    title: o.event.title,
    start: o.start.toISOString(),
    end: o.end.toISOString(),
    allDay: o.allDay,
    kind: o.event.kind,
    recurring: o.recurring,
    lifeAreaId: o.event.lifeAreaId ?? null,
  }));

  // Deadlines: due within the range, plus anything overdue.
  const deadlineEnd = input.kind === "daily" ? startOfDayInZone(addDaysToKey(input.from, 3), tz) : end;
  const deadlines = input.openTasks
    .filter((t) => t.dueAt && Date.parse(t.dueAt) < deadlineEnd.getTime())
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
    .slice(0, 10)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt!, priority: t.priority, source: "task" as const }));

  const scheduledTaskIds = new Set(input.events.filter((e) => e.taskId && e.startsAt && Date.parse(e.startsAt) > input.now.getTime()).map((e) => e.taskId));
  const unscheduledTasks = input.openTasks
    .filter((t) => t.estimatedMinutes && !scheduledTaskIds.has(t.id))
    .slice(0, 10)
    .map((t) => ({ id: t.id, title: t.title, estimatedMinutes: t.estimatedMinutes, dueAt: t.dueAt }));

  const seen = new Set<string>();
  const recurring = input.events
    .filter((e) => e.recurrenceRule && e.startsAt && e.endsAt && e.kind === "fixed")
    .filter((e) => occurrences.some((o) => o.event.id === e.id))
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .slice(0, 12)
    .map((e) => {
      const rule = parseRRule(e.recurrenceRule);
      const zone = e.timezone ?? tz;
      const time = `${clockLabel(timeKeyInZone(new Date(e.startsAt!), zone))}–${clockLabel(timeKeyInZone(new Date(e.endsAt!), zone))}`;
      return { title: e.title, when: `${rule ? describeRecurrence(rule) : "Repeats"}, ${time}` };
    });

  const days = daysBetweenKeys(input.from, input.to) + 1;
  const keys = Array.from({ length: days }, (_, i) => addDaysToKey(input.from, i));
  const habitsDue = input.habits
    .filter((h) => keys.some((k) => isScheduledOn(h.cadence, k)) && !(input.kind === "daily" && h.completedOn.includes(input.from)))
    .slice(0, 10)
    .map((h) => ({ id: h.id, title: h.title }));

  let freeMinutes = 0;
  try {
    freeMinutes = findFreeTime({
      now: input.now.toISOString(),
      timeZone: tz,
      window: { start: (start > input.now ? start : input.now).toISOString(), end: end.toISOString() },
      events: input.events,
      preferences: input.preferences,
    }).reduce((sum, s) => sum + s.minutes, 0);
  } catch {
    freeMinutes = 0;
  }

  const starters: string[] = [];
  const firstDeadline = deadlines[0];
  if (firstDeadline) starters.push(`Help me plan time for ${firstDeadline.title}`);
  if (unscheduledTasks.length > 1) starters.push("Find time for my open tasks");
  if (input.kind === "daily") {
    starters.push("What should I focus on today?");
    if (events.some((e) => !e.allDay)) starters.push("I can't make something today");
  } else {
    starters.push("Here's what's coming up this week");
    if (deadlines.length > 1) starters.push("I don't think I'll have enough time this week");
  }
  if (!events.length && !deadlines.length) starters.push("I have school until 3 every weekday");

  return {
    kind: input.kind,
    timeZone: tz,
    range: { from: input.from, to: input.to },
    events,
    deadlines,
    openTaskCount: input.openTasks.length,
    unscheduledTasks,
    recurring,
    habitsDue,
    freeMinutes,
    starters: starters.slice(0, 4),
  };
}
