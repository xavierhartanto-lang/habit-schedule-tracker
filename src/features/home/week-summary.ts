/**
 * A few plain facts about the next seven days, from real occurrences and
 * tasks. No charts, no scores. Pure, so it is tested.
 */

export type SummaryOccurrence = { dateKey: string; minutes: number; kind: "fixed" | "flexible"; allDay: boolean };
export type SummaryDeadline = { dateKey: string };

export type WeekSummary = {
  commitments: number;
  scheduledMinutes: number;
  deadlines: number;
  /** Local date key of the day with the most scheduled time, if any day has 90+ minutes. */
  busiestDay: string | null;
  /** Days in range with nothing timed on the calendar. */
  openDays: number;
};

export function summarizeWeek(
  days: string[],
  occurrences: SummaryOccurrence[],
  deadlines: SummaryDeadline[],
): WeekSummary {
  const inRange = new Set(days);
  const perDay = new Map<string, number>(days.map((d) => [d, 0]));
  let commitments = 0;
  let scheduledMinutes = 0;
  for (const o of occurrences) {
    if (!inRange.has(o.dateKey)) continue;
    if (o.kind === "fixed") commitments += 1;
    if (o.allDay) continue;
    scheduledMinutes += o.minutes;
    perDay.set(o.dateKey, (perDay.get(o.dateKey) ?? 0) + o.minutes);
  }
  let busiestDay: string | null = null;
  let most = 89;
  for (const [day, minutes] of perDay) {
    if (minutes > most) {
      most = minutes;
      busiestDay = day;
    }
  }
  return {
    commitments,
    scheduledMinutes,
    deadlines: deadlines.filter((d) => inRange.has(d.dateKey)).length,
    busiestDay,
    openDays: [...perDay.values()].filter((m) => m === 0).length,
  };
}
