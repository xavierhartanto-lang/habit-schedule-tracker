import type { Commitment } from "@/lib/domain/types";
import { expandEvents, type Occurrence } from "@/lib/scheduling/recurrence";
import { normalizeText } from "@/lib/ai/extraction";
import { nameTokens } from "./resolve";

/**
 * "Remove duplicates, keep the Google one": the same commitment entered twice,
 * once in Whitespace and once imported from Google Calendar (or twice in
 * Whitespace). Pure and deterministic, so the cleanup is exactly what the
 * user asked for and never a guess by the model.
 *
 * A Whitespace event and a Google event are the same commitment when they
 * take the same slot: most of the shorter one overlaps, and they start within
 * 30 minutes or share a word. Names often differ ("Pre-calculus" vs
 * "Xavier: Precalc w/ Mr. Lee"), so the name is never required.
 * Two Whitespace events need a shared word or the exact same times.
 *
 * The copy that goes is always a Whitespace one. Google events are read-only
 * here, so the Google copy is the one kept. Between two Whitespace copies the
 * more specific (longer) name stays.
 */
export type DuplicatePair = { keep: Occurrence; drop: Occurrence };

const START_SLACK_MS = 30 * 60_000;

function overlapMs(a: Occurrence, b: Occurrence): number {
  return Math.max(0, Math.min(a.end.getTime(), b.end.getTime()) - Math.max(a.start.getTime(), b.start.getTime()));
}

function sameTimes(a: Occurrence, b: Occurrence): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

/** Any shared word counts here: overlapping in time already says "same slot". */
function sharesWord(a: string, b: string): boolean {
  const left = new Set(nameTokens(a));
  return nameTokens(b).some((t) => left.has(t));
}

function isGoogle(o: Occurrence): boolean {
  return o.event.externalSource === "google";
}

function sameCommitment(a: Occurrence, b: Occurrence): boolean {
  const overlap = overlapMs(a, b);
  if (!overlap) return false;
  if (isGoogle(a) !== isGoogle(b)) {
    const shorter = Math.min(a.end.getTime() - a.start.getTime(), b.end.getTime() - b.start.getTime());
    const mostly = overlap >= shorter / 2;
    const closeStart = Math.abs(a.start.getTime() - b.start.getTime()) <= START_SLACK_MS;
    return mostly && (closeStart || sharesWord(a.event.title, b.event.title));
  }
  return sameTimes(a, b) || sharesWord(a.event.title, b.event.title);
}

/** Which of two copies stays: Google first, then the more specific name. */
function keeper(a: Occurrence, b: Occurrence): Occurrence {
  if (isGoogle(a) !== isGoogle(b)) return isGoogle(a) ? a : b;
  return normalizeText(b.event.title).length > normalizeText(a.event.title).length ? b : a;
}

export function findDuplicates(events: readonly Commitment[], from: Date, to: Date, timeZone: string): DuplicatePair[] {
  // Fixed commitments only: Whitespace's own work sessions aren't copies of anything.
  const occ = expandEvents(events.filter((e) => e.kind === "fixed"), from, to, timeZone)
    .filter((o) => !o.allDay)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const dropped = new Set<string>();
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < occ.length; i++) {
    for (let j = i + 1; j < occ.length && occ[j].start < occ[i].end; j++) {
      const a = occ[i];
      const b = occ[j];
      if (dropped.has(a.key) || dropped.has(b.key) || a.event.id === b.event.id) continue;
      if (isGoogle(a) && isGoogle(b)) continue; // both from Google: nothing Whitespace can remove
      if (!sameCommitment(a, b)) continue;
      const keep = keeper(a, b);
      const drop = keep === a ? b : a;
      dropped.add(drop.key);
      pairs.push({ keep, drop });
    }
  }
  return pairs;
}

export type Cleanup =
  /** Every occurrence of a repeating Whitespace event has a Google copy: the series goes. */
  | { kind: "series"; event: Commitment; keptTitles: string[]; count: number }
  /** One copy: a one-time event, or one day of a series. */
  | { kind: "one"; pair: DuplicatePair };

/**
 * What to remove. A repeating Whitespace event whose every occurrence in the
 * range is a duplicate (at least two) goes as a whole series; otherwise only
 * the doubled days are skipped and the rest of the series stays.
 */
export function planCleanup(events: readonly Commitment[], from: Date, to: Date, timeZone: string): Cleanup[] {
  const pairs = findDuplicates(events, from, to, timeZone);
  const bySeries = new Map<string, DuplicatePair[]>();
  for (const p of pairs) {
    if (!p.drop.event.recurrenceRule) continue;
    bySeries.set(p.drop.event.id, [...(bySeries.get(p.drop.event.id) ?? []), p]);
  }
  const whole = new Set<string>();
  const out: Cleanup[] = [];
  for (const [seriesId, list] of bySeries) {
    const event = list[0].drop.event;
    const total = expandEvents([event], from, to, timeZone).length;
    if (list.length >= 2 && list.length === total) {
      whole.add(seriesId);
      out.push({ kind: "series", event, keptTitles: [...new Set(list.map((p) => p.keep.event.title))], count: total });
    }
  }
  for (const p of pairs) if (!whole.has(p.drop.event.id)) out.push({ kind: "one", pair: p });
  return out;
}
