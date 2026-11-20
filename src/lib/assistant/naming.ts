import { normalizeText, type ContextCategory } from "@/lib/ai/extraction";

/**
 * Activity naming: the deterministic half of contextual naming.
 *
 * The planner model proposes a clean, specific title using what Whitespace
 * knows about the user ("I have to tutor a kid tomorrow" -> "Math Tutoring"
 * when the user is known to tutor math). This module makes that safe and
 * consistent, whatever the model returned:
 *
 *   1. formatTitle    natural title case, no first-person filler, no dates
 *                     or times, no sentence-length titles.
 *   2. groundTitle    every specific word must come from the user's words or
 *                     from established context. Invented specifics (a subject,
 *                     a person, a project name) are removed, so an unknown
 *                     subject falls back to a safe general title
 *                     ("Tutoring Session").
 *   3. canonicalName  an activity Whitespace already knows keeps its exact
 *                     existing name, so it is never renamed across views.
 *
 * Pure, no I/O, unit tested.
 */

export type NamingContext = {
  /** Text the title may draw on: the user's words, recent turns, saved facts, existing record names. */
  sources: string[];
  /** Names of things Whitespace already tracks (events, tasks, habits, goals, saved activities). */
  knownNames: string[];
};

export const MAX_TITLE_LENGTH = 60;

/** Generic activity words. They describe the kind of activity, never a subject, person, place or project. */
const GENERIC = new Set([
  "practice",
  "session",
  "sessions",
  "meeting",
  "homework",
  "study",
  "studying",
  "tutoring",
  "review",
  "prep",
  "preparation",
  "development",
  "work",
  "lesson",
  "lessons",
  "rehearsal",
  "class",
  "appointment",
  "workout",
  "training",
  "call",
  "planning",
  "shift",
  "project",
  "club",
  "event",
  "time",
  "group",
]);

/** Generic words that already read as a complete title on their own. */
const STANDALONE = new Set([
  "homework",
  "practice",
  "meeting",
  "rehearsal",
  "appointment",
  "class",
  "lesson",
  "lessons",
  "workout",
  "training",
  "review",
  "call",
  "shift",
  "project",
  "planning",
]);

/** Small words kept lowercase inside a title. */
const SMALL = new Set(["a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "at", "by", "vs", "from", "per", "nor", "but"]);

/** Words that cannot start or end a title. */
const DANGLING = new Set([...SMALL, "due", "my", "our", "some", "about", "around", "until", "till", "&", "+", "-"]);

/** Common student shorthand. Expanding is always safe: the user said the short form. */
const ABBREVIATIONS: Record<string, string> = {
  hw: "Homework",
  hmwk: "Homework",
  chem: "Chemistry",
  bio: "Biology",
  calc: "Calculus",
  precalc: "Precalculus",
  trig: "Trigonometry",
  econ: "Economics",
  gov: "Government",
  govt: "Government",
  psych: "Psychology",
  stats: "Statistics",
  phys: "Physics",
  hist: "History",
  compsci: "Computer Science",
  mtg: "Meeting",
  prac: "Practice",
  appt: "Appointment",
  bball: "Basketball",
  vball: "Volleyball",
};

/** Any weekday spelling, only after "on" / "this" / "next" / "every" ("sat" alone is usually the SAT). */
const DAY = "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?";
/** Weekdays that are safe to remove on their own. */
const FULL_DAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs)s?";
const CLOCK = "\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?";

/** Date, time, duration and frequency phrases. These belong in fields, not in the title. */
const WHEN_PATTERNS: RegExp[] = [
  /\b(?:today|tonight|tomorrow|tmrw|tmr)\b/gi,
  new RegExp(`\\b(?:this|next|every|each|on)\\s+(?:week(?:end)?|morning|afternoon|evening|night|day|${DAY})\\b`, "gi"),
  new RegExp(`\\bon\\s+${DAY}\\b`, "gi"),
  new RegExp(`\\b${FULL_DAY}\\b`, "gi"),
  new RegExp(`\\b(?:at|@|from|until|till|by|around)\\s+${CLOCK}(?:\\s*(?:-|to)\\s*${CLOCK})?`, "gi"),
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
  /\b(?:after|before)\s+school\b/gi,
  /\b(?:in\s+the|this)\s+(?:morning|afternoon|evening)\b/gi,
  /\b(?:once|twice|\d+\s*(?:x|times))\s*(?:a|per|each|every)\s+(?:day|week|month)\b/gi,
  /\b(?:for\s+)?(?:an?|\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|h(?:ou)?rs?|hours?)\b/gi,
  /\b(?:this|next)\s+(?:week|month)\b/gi,
];

/** First-person lead-ins: "I have to", "need to", "gotta". */
const LEAD_INS: RegExp[] = [
  /^(?:so|okay|ok|um|uh|oh|also|and|plus)[,\s]+/i,
  /^(?:i\s*(?:'ve|have)?\s*)?(?:really\s+)?(?:have\s+to|need\s+to|needa|gotta|got\s+to|want\s+to|wanna|must|should|am\s+going\s+to|'m\s+going\s+to|going\s+to|gonna|plan\s+to|will)\s+/i,
  /^i(?:'m|\s+am)\s+(?:going\s+to\s+|gonna\s+)?/i,
  /^i(?:'ll|\s+will)\s+/i,
  /^i\s+(?:have|got|need)\s+/i,
  /^(?:there's|there\s+is)\s+/i,
  /^(?:my|our|the|a|an|some)\s+/i,
];

/** Verbs dropped from the front when a meaningful name remains: "Finish AP Chemistry Lab Report". */
const LEAD_VERBS = /^(?:finish(?:ing)?|complete|completing|get\s+done|work\s+on|working\s+on)\s+/i;

/** Filler words removed anywhere. */
const FILLER = /\b(?:my|our|some|stuff|things|kinda|kind\s+of|sort\s+of|basically|just|really|like)\b/gi;

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimDangling(words: string[]): string[] {
  const out = [...words];
  while (out.length && DANGLING.has(out[0].toLowerCase())) out.shift();
  while (out.length && DANGLING.has(out[out.length - 1].toLowerCase())) out.pop();
  return out;
}

/** Casing the user (or saved context) already uses: "DECA", "AP", "HoopVision". */
function casingMap(sources: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const text of sources) {
    for (const word of text.split(/[^\p{L}\p{N}'+&.-]+/u)) {
      const w = word.replace(/^[.'-]+|[.'-]+$/g, "");
      if (w.length < 2) continue;
      const special = /^[A-Z0-9&+]+$/.test(w) ? /[A-Z]/.test(w) : /[A-Z]/.test(w.slice(1));
      if (special && !map.has(w.toLowerCase())) map.set(w.toLowerCase(), w);
    }
  }
  return map;
}

function capitalize(word: string, isFirst: boolean, casing: Map<string, string>): string {
  const known = casing.get(word.toLowerCase());
  if (known) return known;
  if (!isFirst && SMALL.has(word.toLowerCase())) return word.toLowerCase();
  // Keep acronyms, mixed case names and anything with digits as written.
  if (/[A-Z]/.test(word.slice(1)) || /\d/.test(word)) return word;
  return word
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");
}

export type FormatOptions = {
  /** Remove dates, times, durations and frequencies. Off for goals and facts like "Focus after 8pm". */
  stripWhen?: boolean;
  /** Text whose casing to reuse ("DECA", "AP"). */
  sources?: string[];
};

/**
 * Formats a title for a calendar or a task list: concise, natural title case,
 * no first-person phrasing, no dates or times. Returns null when nothing
 * meaningful is left.
 */
export function formatTitle(raw: string | null | undefined, options: FormatOptions = {}): string | null {
  if (!raw) return null;
  const stripWhen = options.stripWhen ?? true;
  let t = squash(raw.replace(/[“”"]/g, "").replace(/[‘’]/g, "'"));
  t = t.replace(/[.!?,;:…]+$/g, "").trim();

  for (let i = 0; i < 4; i++) {
    const before = t;
    for (const re of LEAD_INS) t = t.replace(re, "");
    if (t === before) break;
  }
  if (stripWhen) for (const re of WHEN_PATTERNS) t = t.replace(re, " ");
  t = squash(t.replace(FILLER, " "));
  t = t.replace(/^(?:do|doing)\s+(?=\S)/i, "");
  const withoutVerb = t.replace(LEAD_VERBS, "");
  if (withoutVerb !== t && withoutVerb.split(" ").filter((w) => !SMALL.has(w.toLowerCase())).length >= 2) t = withoutVerb;
  t = t.replace(/[.!?,;:…]+$/g, "").replace(/\s+[,;:]/g, ",").trim();

  const words = trimDangling(
    t
      .split(" ")
      .filter(Boolean)
      .flatMap((w) => {
        const expanded = ABBREVIATIONS[w.toLowerCase()];
        return expanded ? expanded.split(" ") : [w];
      }),
  );
  if (!words.length) return null;

  const casing = casingMap(options.sources ?? []);
  let title = words.map((w, i) => capitalize(w, i === 0, casing)).join(" ");
  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH + 1);
    title = trimDangling(cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : MAX_TITLE_LENGTH).split(" ")).join(" ");
  }
  return title || null;
}

// ---------------------------------------------------------------------------
// Grounding: specificity without hallucination
// ---------------------------------------------------------------------------

function tokens(text: string): string[] {
  return normalizeText(text)
    .split(/[\s\-/']+/)
    .filter(Boolean);
}

function stem(word: string): string {
  const base = word.replace(/(?:ing|ed|es|e|s)$/, "") || word;
  // "running" -> "run", "planning" -> "plan"
  return base.length > 3 && base.at(-1) === base.at(-2) ? base.slice(0, -1) : base;
}

/** Same meaning in other words. Using one for the other is rewording, not inventing. */
const SYNONYMS: string[][] = [
  ["test", "exam", "quiz", "midterm", "final"],
  ["homework", "hw", "assignment", "worksheet"],
  ["practice", "training", "prac"],
  ["meeting", "mtg"],
  ["essay", "paper"],
  ["game", "match"],
  ["gym", "workout", "lift", "lifting"],
  ["app", "application"],
];

function sourceTokens(sources: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of sources) {
    for (const t of tokens(text)) {
      if (SMALL.has(t)) continue;
      set.add(t);
      const expanded = ABBREVIATIONS[t];
      if (expanded) for (const e of tokens(expanded)) set.add(e);
      for (const group of SYNONYMS) if (group.includes(t)) for (const g of group) set.add(g);
    }
  }
  return set;
}

function isGroundedWord(word: string, sources: Set<string>): boolean {
  if (sources.has(word)) return true;
  const s = stem(word);
  for (const src of sources) {
    if (stem(src) === s) return true;
    // "chem" -> "chemistry", "tutor" -> "tutoring", "math" <- "mathematics"
    if (src.length >= 3 && word.startsWith(src)) return true;
    if (word.length >= 4 && src.startsWith(word)) return true;
  }
  return false;
}

export type GroundResult = {
  title: string;
  /** Words removed because nothing the user said or Whitespace knows supports them. */
  removed: string[];
};

/**
 * Removes specifics nobody established: a subject, person, place or project
 * the user never mentioned and Whitespace has no record of. Generic activity
 * words ("Practice", "Session", "Meeting") are always allowed.
 */
export function groundTitle(title: string, sources: string[]): GroundResult {
  const known = sourceTokens(sources);
  const removed: string[] = [];
  const kept = title.split(" ").filter((word) => {
    const parts = tokens(word);
    if (!parts.length) return true;
    const ok = parts.every((p) => p.length < 2 || SMALL.has(p) || GENERIC.has(p) || isGroundedWord(p, known));
    if (!ok) removed.push(word);
    return ok;
  });
  if (!removed.length) return { title, removed };

  const words = trimDangling(kept);
  if (!words.length) return { title: "", removed };
  if (words.length === 1 && GENERIC.has(words[0].toLowerCase()) && !STANDALONE.has(words[0].toLowerCase())) {
    // "Math Tutoring" with no known subject -> "Tutoring Session".
    words.push("Session");
  }
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return { title: words.join(" "), removed };
}

/** Reuses the exact name of something Whitespace already tracks. */
export function canonicalName(title: string, knownNames: string[]): string {
  const n = normalizeText(title);
  const match = knownNames.find((k) => normalizeText(k) === n);
  return match ?? title;
}

export type NameResult = {
  title: string | null;
  /** Specific words dropped as unsupported. */
  removed: string[];
};

/**
 * Full naming pass for a new activity: format, ground, then reuse an
 * existing name. `fallback` (the user's own words) is used when the model's
 * title has nothing usable left.
 */
export function nameActivity(
  raw: string | null,
  context: NamingContext,
  options: { stripWhen?: boolean; fallback?: string | null } = {},
): NameResult {
  const format = (value: string | null | undefined) => formatTitle(value, { stripWhen: options.stripWhen, sources: context.sources });
  const formatted = format(raw);
  if (!formatted) return { title: format(options.fallback), removed: [] };
  const grounded = groundTitle(formatted, context.sources);
  const title = grounded.title || format(options.fallback) || null;
  return { title: title ? canonicalName(title, context.knownNames) : null, removed: grounded.removed };
}

/**
 * Onboarding facts (Phase 2 extraction) follow the same naming style. They
 * are always grounded in the user's own words already, so this only formats.
 * Routines, working times and preferences keep their wording and times
 * ("Focus after 8pm"), and goals keep their target ("1500 on the SAT by June").
 */
export function formatFactTitle(category: ContextCategory, title: string, sources: string[] = []): string {
  if (category !== "commitment" && category !== "activity" && category !== "interest" && category !== "goal") return title;
  return formatTitle(title, { stripWhen: category !== "goal", sources }) ?? title;
}
