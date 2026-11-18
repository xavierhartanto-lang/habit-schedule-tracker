import { z } from "zod";
import { addDaysToKey, isoWeekdayOfKey, startOfWeekKey } from "@/lib/scheduling/zoned";
import type { ValidationResult } from "./context-items";
import { WEEKDAYS, type Habit, type HabitCadence, type Weekday } from "./types";
import { check, zOptionalAreaId, zOptionalText, zTitle } from "./validation";

/**
 * Habits: frequency, due days and simple progress.
 * Progress is a completion rate, not a streak: missing a day never resets
 * anything, and there are no points or badges.
 */

/** Full weeks of history shown, plus the current week. */
export const HISTORY_WEEKS = 12;

export type HabitForm = {
  title: string;
  description?: string | null;
  lifeAreaId?: string | null;
  cadence: HabitCadence;
};

export type HabitWrite = {
  title: string;
  description: string | null;
  lifeAreaId: string | null;
  cadence: HabitCadence;
};

const zWeekday = z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]);

const schema = z.object({
  title: zTitle(200),
  description: zOptionalText(500, "Description"),
  lifeAreaId: zOptionalAreaId,
  cadence: z.discriminatedUnion(
    "type",
    [
      z.object({ type: z.literal("daily") }),
      z.object({
        type: z.literal("weekly"),
        timesPerWeek: z.number().int().min(1, "At least once a week.").max(7, "At most 7 times a week."),
      }),
      z.object({
        type: z.literal("specific_days"),
        days: z.array(zWeekday).min(1, "Pick at least one day.").max(7),
      }),
    ],
    { error: "Choose how often." },
  ),
});

export function validateHabitForm(raw: unknown): ValidationResult<HabitWrite> {
  const parsed = check(schema, raw);
  if (!parsed.ok) return parsed;
  const f = parsed.value;
  const cadence: HabitCadence =
    f.cadence.type === "specific_days"
      ? { type: "specific_days", days: WEEKDAYS.filter((d) => (f.cadence as { days: Weekday[] }).days.includes(d)) }
      : f.cadence;
  return { ok: true, value: { title: f.title, description: f.description, lifeAreaId: f.lifeAreaId, cadence } };
}

export function cadenceLabel(c: HabitCadence): string {
  if (c.type === "daily") return "Every day";
  if (c.type === "weekly") return c.timesPerWeek === 7 ? "7× a week" : `${c.timesPerWeek}× a week`;
  const names: Record<Weekday, string> = { mo: "Mon", tu: "Tue", we: "Wed", th: "Thu", fr: "Fri", sa: "Sat", su: "Sun" };
  if (c.days.length === 7) return "Every day";
  if (c.days.length === 5 && !c.days.includes("sa") && !c.days.includes("su")) return "Weekdays";
  return c.days.map((d) => names[d]).join(", ");
}

function weekdayOf(key: string): Weekday {
  return WEEKDAYS[isoWeekdayOfKey(key) - 1];
}

/** Whether the habit is planned for this specific date. Weekly targets can happen any day. */
export function isScheduledOn(c: HabitCadence, dateKey: string): boolean {
  if (c.type === "specific_days") return c.days.includes(weekdayOf(dateKey));
  return true;
}

/** How many completions a full week asks for. */
export function weeklyTarget(c: HabitCadence): number {
  if (c.type === "daily") return 7;
  if (c.type === "weekly") return c.timesPerWeek;
  return c.days.length;
}

/** Completions in the week containing `dateKey`, against that week's target. */
export function weekProgress(
  habit: Pick<Habit, "cadence" | "completedOn">,
  dateKey: string,
  weekStartsOn: 0 | 1,
): { done: number; target: number } {
  const start = startOfWeekKey(dateKey, weekStartsOn);
  const end = addDaysToKey(start, 6);
  const done = habit.completedOn.filter((d) => d >= start && d <= end).length;
  return { done, target: weeklyTarget(habit.cadence) };
}

/**
 * Share of planned completions met over the last `weeks` full weeks plus
 * the current week so far. Days before the habit existed don't count.
 * Returns 0-100, or null when there is nothing to measure yet.
 */
export function completionRate(
  habit: Pick<Habit, "cadence" | "completedOn">,
  todayKey: string,
  weeks: number,
  weekStartsOn: 0 | 1,
  createdKey?: string,
): number | null {
  const thisWeek = startOfWeekKey(todayKey, weekStartsOn);
  const from = addDaysToKey(thisWeek, -7 * weeks);
  const firstDay = createdKey && createdKey > from ? createdKey : from;
  let planned = 0;
  let done = 0;
  const completed = new Set(habit.completedOn);

  for (let w = 0; w <= weeks; w++) {
    const ws = addDaysToKey(from, 7 * w);
    const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(ws, i)).filter(
      (d) => d >= firstDay && d <= todayKey,
    );
    if (!days.length) continue;
    const doneThisWeek = days.filter((d) => completed.has(d)).length;
    if (habit.cadence.type === "weekly") {
      // Prorate the weekly target for partial weeks.
      const target = Math.ceil((habit.cadence.timesPerWeek * days.length) / 7);
      planned += target;
      done += Math.min(doneThisWeek, target);
    } else {
      const scheduled = days.filter((d) => isScheduledOn(habit.cadence, d));
      planned += scheduled.length;
      done += scheduled.filter((d) => completed.has(d)).length;
    }
  }
  if (planned === 0) return null;
  return Math.round((done / planned) * 100);
}
