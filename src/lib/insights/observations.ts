import { duration, roughly, weekdayLong } from "@/lib/proactive/text";
import { compareWeeks, type WeekTime } from "./area-time";

/**
 * Phase 7.6: a few plain observations about this week, from the numbers
 * only. No scores, no streaks, no guessing why. Each one is something the
 * user can check on their calendar. Pure.
 */

export type Observation = { id: string; title: string; body: string };

const MAX = 4;
/** Rounded so it doesn't sound falsely precise; zero stays zero. */
const amount = (m: number) => (m > 0 ? duration(roughly(m)) : "nothing");
const CHANGE_MINUTES = 120;

export function observations(thisWeek: WeekTime, lastWeek: WeekTime, todayKey: string): Observation[] {
  const out: Observation[] = [];
  const t = thisWeek.totals;

  // Plan vs reality for Whitespace sessions, only what the user recorded.
  const past = t.done + t.partial + t.missed + t.unrecorded;
  if (t.missed > 0) {
    out.push({
      id: "missed",
      title: `${duration(roughly(t.missed))} of sessions missed`,
      body: `Of ${duration(roughly(past))} of past sessions this week, you marked ${duration(roughly(t.missed))} as missed. If a time keeps not working, it may be the time, not you.`,
    });
  }
  if (t.unrecorded >= 30) {
    out.push({
      id: "unrecorded",
      title: `${duration(roughly(t.unrecorded))} of sessions not recorded`,
      body: "These have passed without an answer, so they aren't counted as done or missed. Marking them on Home keeps these numbers honest.",
    });
  }

  // The biggest shift between weeks, by scheduled time. Last week is complete; this one may not be.
  // While the week is still going, a drop may just be events not added yet: only report drops once it's over.
  const inProgress = todayKey < thisWeek.days[6];
  const shift = compareWeeks(thisWeek, lastWeek)
    .filter((c) => Math.abs(c.delta) >= CHANGE_MINUTES && c.areaId !== null && !(inProgress && c.delta < 0))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))[0];
  if (shift) {
    const sofar = inProgress ? " so far" : "";
    out.push({
      id: `shift:${shift.areaId}`,
      title: `${shift.name} ${shift.delta > 0 ? "up" : "down"} ${duration(roughly(Math.abs(shift.delta)))}`,
      body: `${amount(shift.thisWeek)} scheduled this week${sofar}, against ${amount(shift.lastWeek)} last week.`,
    });
  }

  const unassigned = thisWeek.areas.find((a) => a.areaId === null);
  if (unassigned && unassigned.scheduled >= 120 && unassigned.scheduled >= t.scheduled * 0.25) {
    out.push({
      id: "unassigned",
      title: `${duration(roughly(unassigned.scheduled))} without a life area`,
      body: "Whitespace doesn't guess where that time belongs. Give those events an area and they'll show up in the breakdown.",
    });
  }

  // Against the days that had anything, so a quiet weekend doesn't make every school day look heavy.
  const used = thisWeek.perDay.filter((d) => d.scheduled > 0);
  const busiest = [...used].sort((a, b) => b.scheduled - a.scheduled)[0];
  const avg = used.reduce((s, d) => s + d.scheduled, 0) / Math.max(1, used.length);
  if (busiest && used.length >= 3 && busiest.scheduled >= 240 && busiest.scheduled >= avg * 1.4) {
    out.push({
      id: "busiest",
      title: `${weekdayLong(busiest.date)} is the busiest day`,
      body: `${amount(busiest.scheduled)} on the calendar, about ${amount(busiest.scheduled - avg)} more than a typical day this week.`,
    });
  }
  return out.slice(0, MAX);
}
