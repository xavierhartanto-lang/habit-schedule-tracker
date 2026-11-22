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
 * Two occurrences are the same commitment when they overlap in time and
 * either share a word ("Math Tutoring" / "Devsmita Das: Tutoring RSM")
 * or have the exact same start and end.
 *
 * The copy that goes is always a Whitespace one. Google events are read-only
 * here, so the Google copy is the one kept. Between two Whitespace copies the
 * more specific (longer) name stays.
 */
export type DuplicatePair = { keep: Occurrence; drop: Occurrence };

function overlaps(a: Occurrence, b: Occurrence): boolean {
  return a.start < b.end && b.start < a.end;
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
      if (!overlaps(a, b)) continue;
      if (!sameTimes(a, b) && !sharesWord(a.event.title, b.event.title)) continue;
      const keep = keeper(a, b);
      const drop = keep === a ? b : a;
      dropped.add(drop.key);
      pairs.push({ keep, drop });
    }
  }
  return pairs;
}
