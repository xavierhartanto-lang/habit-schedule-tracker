import { z } from "zod";

/**
 * Phase 7.6: the weekly briefing's short AI summary. The model gets only
 * the deterministic fact lines and may only restate them. Its output is
 * checked here: anything that adds a number, a day or a quoted name the
 * facts don't contain is thrown away, and the factual briefing shows
 * instead. Pure, unit tested.
 */

export const BriefingWireSchema = z.object({
  summary: z.string().describe("Two or three short sentences. Only facts from <facts>."),
});
export type BriefingWire = z.infer<typeof BriefingWireSchema>;

export const BRIEFING_SYSTEM_PROMPT = `You write a weekly briefing for a busy high school student, in Whitespace's voice: calm, direct, like a coach who has seen it all.

Rules
- Two or three short sentences, under 70 words. Plain words. No greeting, no sign-off, no emojis, no exclamation marks.
- Use only what is in <facts>. Never add events, deadlines, times, numbers, days or free time that are not there.
- Lead with what matters most this week (a problem, a heavy day, a big deadline). Then one recommendation, taken from the facts' problems if there are any.
- Never say the student attended, finished or skipped something unless the facts say so. Time on the calendar is not time spent.
- No guilt, no praise inflation, no scores. If the week looks calm, say so plainly.`;

export function buildBriefingPrompt(lines: readonly string[], heading: string): string {
  return [`<week>${heading}</week>`, "<facts>", ...lines.map((l) => `- ${l}`), "</facts>", "Write the briefing."].join("\n");
}

const MAX_CHARS = 520;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Every number in the summary must appear in the facts; same for weekdays and quoted names. */
export function validateBriefing(summary: string, lines: readonly string[]): string | null {
  const text = summary.replace(/\s+/g, " ").trim();
  if (text.length < 20 || text.length > MAX_CHARS) return null;
  const facts = lines.join(" ").toLowerCase();
  const lower = text.toLowerCase();

  const numbers = new Set(facts.match(/\d+(?:[.:]\d+)?/g) ?? []);
  for (const n of lower.match(/\d+(?:[.:]\d+)?/g) ?? []) if (!numbers.has(n)) return null;
  for (const d of WEEKDAYS) if (new RegExp(`\\b${d}`).test(lower) && !facts.includes(d)) return null;
  // Spelled-out counts ("three deadlines") must match a digit in the facts.
  for (const [i, w] of NUMBER_WORDS.entries()) if (new RegExp(`\\b${w}\\b`).test(lower) && !numbers.has(String(i + 2))) return null;
  for (const q of text.match(/[“"]([^”"]{2,80})[”"]/g) ?? []) {
    const inner = q.slice(1, -1).toLowerCase();
    if (!facts.includes(inner)) return null;
  }
  if (/!|\p{Extended_Pictographic}/u.test(text)) return null;
  return text;
}
