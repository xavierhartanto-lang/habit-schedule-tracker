/**
 * Phase 7.3 exam prep. An exam, test or quiz on the calendar with nothing
 * planned to study for it gets a concrete proposal: a few study sessions
 * before it, sized by how close it is. Deterministic, no AI. Uses only the
 * event title and the titles of the user's own tasks and sessions. Pure.
 */

const EXAM = /\b(exams?|tests?|quiz(?:zes)?|finals?|midterms?|assessments?|sat|act|ap|ib|olympiad)\b/i;
/** Words that say nothing about the subject. */
const NOISE = new Set([
  "exam", "exams", "test", "tests", "quiz", "quizzes", "final", "finals", "midterm", "midterms", "assessment", "assessments",
  "unit", "chapter", "ch", "the", "and", "for", "on", "in", "of", "a", "an", "my", "class", "period", "study", "review", "prep",
  "practice", "session", "sessions", "big", "mock", "retake", "part",
]);
const PREP = /\b(study|studying|review|revise|revision|prep|prepare|practice|flashcards?)\b/i;

/** Study sessions are never planned for an exam less than this far away. */
const MIN_LEAD_HOURS = 12;
/** Nor for one further out than this: too early to be useful. */
export const EXAM_LOOKAHEAD_DAYS = 10;

export function isExam(title: string): boolean {
  return EXAM.test(title);
}

/** "Chemistry Unit 4 Test" -> ["chemistry"]. Numbers and short words are left out. */
export function subjectWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));
  const named = words.filter((w) => /[a-z]/.test(w) && w.length >= 3);
  return named;
}

/**
 * Something already prepares for it: a task or session that names its subject,
 * or, for an exam with no subject in its name, one that names the exam itself.
 */
export function hasPrep(examTitle: string, titles: string[]): boolean {
  const subject = subjectWords(examTitle);
  const exam = examTitle.toLowerCase().trim();
  return titles.some((raw) => {
    const t = raw.toLowerCase();
    if (t.trim() === exam) return false; // the exam event itself
    const words = new Set(t.split(/[^a-z0-9]+/));
    if (subject.length) return subject.some((w) => words.has(w));
    return PREP.test(t) && t.includes(exam);
  });
}

export type ExamPrepPlan = { sessions: number; minutesEach: number; title: string };

/**
 * How much to study: one session the day before, two or three for an exam a
 * few days out, each within the user's session limits and the realistic free
 * time before it (`capacity`, minutes). Null when there's no time or it's too
 * soon or too far.
 */
export function examPrepPlan(
  exam: { title: string; startMs: number },
  ctx: { nowMs: number; minSessionMinutes: number; maxSessionMinutes: number; capacity: number },
): ExamPrepPlan | null {
  const hours = (exam.startMs - ctx.nowMs) / 3_600_000;
  if (hours < MIN_LEAD_HOURS || hours > EXAM_LOOKAHEAD_DAYS * 24) return null;
  const days = hours / 24;
  const wanted = days <= 1.5 ? 1 : days <= 3.5 ? 2 : 3;
  const base = wanted === 1 ? 60 : 45;
  const minutesEach = Math.min(ctx.maxSessionMinutes, Math.max(ctx.minSessionMinutes, base));
  const sessions = Math.min(wanted, Math.floor(ctx.capacity / minutesEach));
  if (sessions < 1) return null;
  return { sessions, minutesEach, title: `Study for ${exam.title}` };
}
