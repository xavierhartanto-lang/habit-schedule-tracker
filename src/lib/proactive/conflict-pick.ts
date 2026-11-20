/**
 * When two fixed commitments overlap, which one should give way? Whitespace
 * proposes an answer instead of asking the user to brainstorm, and the
 * user approves or picks the other. Deterministic, no AI:
 *
 *   1. A one-time event beats a repeating one: missing one week of a
 *      weekly class costs far less than missing a recital.
 *   2. Between two one-time events, an occasion (recital, exam, game,
 *      interview...) beats a routine (practice, lesson, tutoring...).
 *   3. Otherwise there is no honest default: ask.
 *
 * Only the title and whether it repeats are used. Nothing is assumed about
 * the person. Pure.
 */

export type ConflictSide = { id: string; title: string; recurring: boolean };

export type ConflictPick = {
  keep: ConflictSide;
  drop: ConflictSide;
  /** Short reason, shown to the user: "The recital only happens once." */
  why: string;
};

const OCCASION =
  /\b(recitals?|concerts?|performances?|shows?|exams?|tests?|finals?|midterms?|quiz(?:zes)?|games?|matches|match|tournaments?|meets?|competitions?|championships?|playoffs?|auditions?|interviews?|presentations?|graduations?|ceremon(?:y|ies)|weddings?|funerals?|birthdays?|doctor|dentist|orthodontist|appointments?|surgery|trip|flight|college visit|tour)\b/i;
const ROUTINE = /\b(practices?|class(?:es)?|lessons?|tutoring|tutor|club|meetings?|study|studying|training|rehearsals?|sessions?|homework|workout|gym|lab)\b/i;

function weight(title: string): number {
  const occasion = OCCASION.test(title);
  const routine = ROUTINE.test(title);
  if (occasion && !routine) return 2;
  if (occasion && routine) return 1; // "Game day practice": unclear
  return routine ? 0 : 1;
}

/** "the recital", from "Piano Recital". */
function shortName(title: string): string {
  const m = title.match(OCCASION);
  return m ? `the ${m[0].toLowerCase()}` : title;
}

export function pickKeeper(a: ConflictSide, b: ConflictSide): ConflictPick | null {
  if (a.recurring !== b.recurring) {
    const [keep, drop] = a.recurring ? [b, a] : [a, b];
    const name = shortName(keep.title);
    return { keep, drop, why: `${name.charAt(0).toUpperCase()}${name.slice(1)} only happens once.` };
  }
  if (a.recurring) return null;
  const wa = weight(a.title);
  const wb = weight(b.title);
  if (wa === wb) return null;
  const [keep, drop] = wa > wb ? [a, b] : [b, a];
  const name = shortName(keep.title);
  return { keep, drop, why: `${name.charAt(0).toUpperCase()}${name.slice(1)} is harder to reschedule than ${drop.title}.` };
}
