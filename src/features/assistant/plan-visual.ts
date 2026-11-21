import type { PlanItem, PlanView } from "./plan-types";

/**
 * Picks the fastest way to show a plan, from its shape. Deterministic, so
 * the card renders instantly and the same plan always looks the same.
 *
 *   steps  two or more sessions for steps of one bigger task  -> step path
 *   day    timed calendar changes on one day                  -> time strip
 *   week   timed calendar changes within one 7-day span      -> stacked day strips
 *   list   everything else (tasks, habits, facts, all-day)    -> compact rows
 */
export type PlanVisual = "steps" | "day" | "week" | "list";

export const isTimed = (i: PlanItem) => !!i.timing && !i.timing.allDay;

export function choosePlanVisual(items: readonly PlanItem[]): PlanVisual {
  const timed = items.filter((i) => i.group === "calendar" && isTimed(i));
  if (!timed.length) return "list";
  const parents = new Map<string, number>();
  for (const i of timed) if (i.step) parents.set(i.step.parentId, (parents.get(i.step.parentId) ?? 0) + 1);
  if ([...parents.values()].some((n) => n >= 2)) return "steps";
  const days = [...new Set(timed.map((i) => i.timing!.date))].sort();
  if (days.length === 1) return "day";
  const span = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000;
  return span < 7 ? "week" : "list";
}

/** Plan whose steps make up the step path (the parent with the most sessions). */
export function stepGroup(items: readonly PlanItem[]): NonNullable<PlanItem["step"]> | null {
  const counts = new Map<string, { n: number; step: NonNullable<PlanItem["step"]> }>();
  for (const i of items) {
    if (!i.step || !isTimed(i)) continue;
    const c = counts.get(i.step.parentId);
    counts.set(i.step.parentId, { n: (c?.n ?? 0) + 1, step: c?.step ?? i.step });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best?.step ?? null;
}

export type Tone = "plain" | "warn" | "danger";

/**
 * Two-to-three word tag for a left-out item, read from the planner's own
 * wording. Unknown wording gets no tag; the full reason stays one tap away.
 */
export function leftOutTag(entry: PlanView["unscheduled"][number]): { label: string; tone: Tone } | null {
  const r = entry.reason;
  if (/overdue/i.test(r)) return { label: "Overdue · next up", tone: "danger" };
  if (/it's tight/i.test(r)) {
    const due = r.match(/Due ([^,.]+)/);
    return { label: due ? `Tight · due ${lower(due[1])}` : "Tight", tone: "danger" };
  }
  const due = r.match(/Due ([^,.]+)/);
  if (due) return { label: `Due ${lower(due[1])}`, tone: /today|tonight/i.test(due[1]) ? "warn" : "plain" };
  if (/no time estimate/i.test(r)) return { label: "No estimate", tone: "plain" };
  if (/already full/i.test(r)) return { label: "Day full", tone: "plain" };
  if (entry.minutes > 0) return { label: `${shortDuration(entry.minutes)} short`, tone: "warn" };
  return null;
}

const lower = (s: string) => s.replace(/^(Today|Tomorrow|Tonight)$/, (m) => m.toLowerCase());

export function shortDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "45 min", "1 h 30 min", "2 h" -> minutes. */
export function parseDuration(text: string): number | null {
  const m = text.match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*min)?/);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

export type FactVisual = {
  /** Work left vs free time, when both are known: drawn as a bar. */
  capacity: { work: number; free: number } | null;
  /** The rest, as short chips. */
  chips: { label: string; kind: "due" | "time" | "warn" | "plain" }[];
};

/** Turns a nudge's fact lines into a capacity bar plus short chips. */
export function factVisual(facts: readonly string[]): FactVisual {
  let work: number | null = null;
  let free: number | null = null;
  const chips: FactVisual["chips"] = [];
  for (const f of facts) {
    const w = f.match(/^About (.+) of work left$/);
    if (w) {
      work = parseDuration(w[1]);
      if (work !== null) continue;
    }
    const fr = f.match(/^About (.+) free (before then|today|tomorrow|.*)$/);
    if (fr) {
      free = parseDuration(fr[1]);
      if (free !== null) continue;
    }
    if (/^Due /.test(f)) chips.push({ label: f, kind: "due" });
    else if (/^Overlaps|^Postponed/.test(f)) chips.push({ label: f, kind: "warn" });
    else if (/\d+\s*(h|min)\b/.test(f)) chips.push({ label: f, kind: "time" });
    else chips.push({ label: f, kind: "plain" });
  }
  const capacity = work !== null && free !== null ? { work, free } : null;
  if (!capacity) {
    if (work !== null) chips.push({ label: `${shortDuration(work)} of work left`, kind: "time" });
    if (free !== null) chips.push({ label: `${shortDuration(free)} free`, kind: "time" });
  }
  return { capacity, chips };
}

export type StripBlock = {
  key: string;
  start: number;
  end: number;
  label: string;
  kind: "busy" | "new" | "ghost" | "conflict" | "removed" | "done";
};

/** Visible hours for a time strip: whole hours around everything shown, at least 3 h wide. */
export function stripWindow(blocks: readonly { start: number; end: number }[], deadline: number | null, tz: string): { start: number; end: number } {
  const HOUR = 3_600_000;
  let lo = Math.min(...blocks.map((b) => b.start));
  let hi = Math.max(...blocks.map((b) => b.end));
  if (deadline !== null && deadline > hi && deadline - hi <= 6 * HOUR) hi = deadline;
  lo = floorHour(lo, tz);
  hi = Math.max(lo + 3 * HOUR, ceilHour(hi, tz));
  return { start: lo, end: hi };
}

function offsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function floorHour(ms: number, tz: string): number {
  const local = ms + offsetMs(ms, tz);
  return local - (((local % 3_600_000) + 3_600_000) % 3_600_000) - offsetMs(ms, tz);
}

function ceilHour(ms: number, tz: string): number {
  const f = floorHour(ms, tz);
  return f === ms ? ms : f + 3_600_000;
}
