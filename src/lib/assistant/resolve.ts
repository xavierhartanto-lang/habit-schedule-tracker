import { normalizeText } from "@/lib/ai/extraction";
import { ABBREVIATIONS } from "./naming";

/**
 * Deterministic entity resolution: which saved task, event, habit or goal
 * the user means. Pure, unit tested.
 *
 * The planner model suggests a ref ("t3") and the user's words for it. The
 * ref is only trusted when the record's name matches those words. When the
 * words match nothing, nothing is picked ("mark training done" never
 * completes "Chemistry Homework"). When several match, the user is asked.
 */

const STOP = new Set(["the", "a", "an", "my", "our", "for", "with", "of", "to", "and", "at", "on", "in", "task", "event", "thing", "one", "that", "this", "it"]);

/** Words that say what kind of activity it is, not which one. A match on these alone is weak. */
const GENERIC = new Set([
  "practice",
  "session",
  "meeting",
  "homework",
  "study",
  "tutor",
  "review",
  "prep",
  "work",
  "lesson",
  "class",
  "appointment",
  "workout",
  "train",
  "call",
  "project",
  "club",
  "time",
  "game",
  "assignment",
  "test",
  "exam",
  "quiz",
]);

const ABBREV = new Map(Object.entries(ABBREVIATIONS).map(([k, v]) => [k, v.toLowerCase()]));

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) return word.slice(0, -1);
  return word;
}

/** Comparable words of a name: lowercase, shorthand expanded, light stemming, no filler. */
export function nameTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of normalizeText(text).replace(/[:'-]/g, " ").split(" ")) {
    if (!raw) continue;
    const expanded = ABBREV.get(raw) ?? raw;
    for (const w of expanded.split(" ")) {
      if (!w || STOP.has(w)) continue;
      const s = stem(w);
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

export const isGenericToken = (t: string) => GENERIC.has(t);

/**
 * How well `query` (the user's words) names `title`, 0..1.
 * 1 = same words. A match only on generic words ("practice") scores low.
 */
export function nameScore(query: string | null | undefined, title: string): number {
  const q = nameTokens(query);
  const t = nameTokens(title);
  if (!q.length || !t.length) return 0;
  const shared = q.filter((w) => t.includes(w));
  if (!shared.length) return 0;
  if (shared.length === q.length && shared.length === t.length) return 1;
  const score = 0.6 * (shared.length / q.length) + 0.4 * (shared.length / t.length);
  return shared.every(isGenericToken) ? score * 0.4 : score;
}

/** Above this the name is a match; between WEAK and STRONG it is only worth asking about. */
export const STRONG = 0.5;
export const WEAK = 0.15;

export type Resolution<T> =
  | { kind: "one"; ref: string; item: T; via: "ref" | "name" }
  | { kind: "ask"; options: { ref: string; item: T }[] }
  | { kind: "none" };

/**
 * Picks the record the user means.
 *  - A ref from the model is used when no words were given, or the words match it.
 *  - Otherwise the best name match wins if it is clearly ahead.
 *  - Close matches, or only weak ones, become a question. No match: none.
 */
export function resolveEntity<T extends { title: string }>(
  map: Map<string, T>,
  ref: string | null,
  words: string | null,
  options: { pool?: string[] } = {},
): Resolution<T> {
  const entries = [...map.entries()].filter(([r]) => !options.pool || options.pool.includes(r));
  if (ref && map.has(ref)) {
    const item = map.get(ref)!;
    if (!words || nameScore(words, item.title) >= STRONG) return { kind: "one", ref, item, via: "ref" };
  }
  if (!words) return { kind: "none" };

  const scored = entries
    .map(([r, item]) => ({ ref: r, item, score: nameScore(words, item.title) }))
    .filter((s) => s.score >= WEAK)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { kind: "none" };

  // Several records with the same name (one event per week, say) are one thing to the user.
  const top = scored[0];
  const sameName = scored.filter((s) => normalizeText(s.item.title) === normalizeText(top.item.title));
  const rest = scored.filter((s) => normalizeText(s.item.title) !== normalizeText(top.item.title));
  if (top.score >= STRONG && (!rest.length || rest[0].score < top.score - 0.2) && sameName.length === 1) {
    return { kind: "one", ref: top.ref, item: top.item, via: "name" };
  }
  if (top.score >= STRONG && sameName.length > 1 && (!rest.length || rest[0].score < top.score - 0.2)) {
    // Same name, different records: the caller decides (by date) or asks.
    return { kind: "ask", options: sameName.slice(0, 4).map(({ ref: r, item }) => ({ ref: r, item })) };
  }
  return { kind: "ask", options: scored.slice(0, 4).map(({ ref: r, item }) => ({ ref: r, item })) };
}
