import "server-only";

import { listActiveHabits } from "@/lib/db/habits";
import { getPreferences } from "@/lib/db/profiles";
import { loadSchedulingBase } from "@/lib/db/scheduling";
import { clockLabel, shortDate } from "@/lib/assistant/dates";
import { addDaysToKey, dateKeyInZone, startOfWeekKey, timeKeyInZone } from "@/lib/scheduling/zoned";
import type { CheckIn, CheckInKind } from "../plan-types";
import { buildCheckIn } from "./checkin-build";

/**
 * Daily and weekly check-in data, from real records only. Used by the
 * assistant's opening message for a check-in conversation and available to
 * the home page. Never fills gaps with samples.
 */
export async function loadCheckIn(userId: string, kind: CheckInKind, now = new Date()): Promise<CheckIn> {
  const prefs = await getPreferences(userId);
  const weekStartsOn = prefs?.weekStartsOn ?? 1;
  // Load generously, then narrow once the user's zone is known.
  const base = await loadSchedulingBase(userId, {
    start: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    end: new Date(now.getTime() + 16 * 86_400_000).toISOString(),
  });
  const tz = base.timeZone;
  const todayKey = dateKeyInZone(now, tz);
  const from = todayKey;
  const to = kind === "daily" ? todayKey : addDaysToKey(startOfWeekKey(todayKey, weekStartsOn), 6);
  const habits = await listActiveHabits(userId, { from, to });
  return buildCheckIn({ kind, now, timeZone: tz, from, to, events: base.events, openTasks: base.openTasks, habits, preferences: base.preferences });
}

export { buildCheckIn };

/** Plain-text version for the reply model's <check_in> block. */
export function checkInText(c: CheckIn): string {
  const lines: string[] = [`Range: ${shortDate(c.range.from)}${c.range.to !== c.range.from ? ` to ${shortDate(c.range.to)}` : ""}`];
  if (c.events.length) {
    lines.push("Events:");
    for (const e of c.events.slice(0, 25)) {
      const d = dateKeyInZone(new Date(e.start), c.timeZone);
      const when = e.allDay
        ? `${shortDate(d)} (all day)`
        : `${shortDate(d)} ${clockLabel(timeKeyInZone(new Date(e.start), c.timeZone))}-${clockLabel(timeKeyInZone(new Date(e.end), c.timeZone))}`;
      lines.push(`- ${e.title}: ${when}${e.kind === "flexible" ? " (flexible)" : ""}`);
    }
  } else lines.push("Events: none.");
  if (c.recurring.length) lines.push(`Recurring: ${c.recurring.map((r) => `${r.title} (${r.when})`).join("; ")}`);
  if (c.deadlines.length) {
    lines.push("Deadlines:");
    for (const d of c.deadlines) lines.push(`- ${d.title}: due ${shortDate(dateKeyInZone(new Date(d.dueAt), c.timeZone))}${d.priority === "high" ? " (high priority)" : ""}`);
  } else lines.push("Deadlines: none.");
  lines.push(`Open tasks: ${c.openTaskCount}.`);
  if (c.unscheduledTasks.length) lines.push(`Tasks with time estimates and nothing scheduled: ${c.unscheduledTasks.map((t) => t.title).join(", ")}`);
  if (c.habitsDue.length) lines.push(`Habits due: ${c.habitsDue.map((h) => h.title).join(", ")}`);
  lines.push(`Free time inside working hours: about ${Math.round(c.freeMinutes / 60)} h.`);
  return lines.join("\n");
}
