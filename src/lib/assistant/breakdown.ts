import { z } from "zod";

import type { Task } from "@/lib/domain/types";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys, zonedToUtc } from "@/lib/scheduling/zoned";

/**
 * Phase 7.3 task breakdown. The model only names the steps and sizes them.
 * Everything else is deterministic here: step count limits, minutes scaled
 * to the task's own estimate, and due dates spread evenly between today and
 * the task's due date (the model never computes dates). Nothing is saved
 * until the user taps Save. Pure, unit tested.
 */

export const MIN_STEPS = 2;
export const MAX_STEPS = 6;
const MIN_STEP_MINUTES = 10;
const MAX_STEP_MINUTES = 240;

/** Union-free on purpose (see intents.ts): every field required. */
export const BreakdownWireSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe("Short action, verb first, in title case, e.g. 'Outline the Argument'. No dates or times."),
        minutes: z.number().int().describe("Realistic minutes of focused work for this step."),
      }),
    )
    .describe(`${MIN_STEPS}-${MAX_STEPS} steps in the order they should be done.`),
});
export type BreakdownWire = z.infer<typeof BreakdownWireSchema>;

export const BREAKDOWN_SYSTEM_PROMPT = `You break a high school student's task into a few concrete steps.

Rules
- ${MIN_STEPS} to ${MAX_STEPS} steps, in the order they should be done. Fewer is better when the task is small.
- Each step is one sitting of focused work with a clear finish line ("Draft the Introduction", not "Work on essay").
- Titles are short, verb first, title case. No dates, times or numbering.
- Minutes are realistic for a student. When a total estimate is given, the steps add up to about that total.
- Use only what the task says. Don't invent requirements, sources or teachers.`;

export function buildBreakdownPrompt(task: Pick<Task, "title" | "description" | "estimatedMinutes">, dueLabel: string | null): string {
  return [
    `<task>${task.title}</task>`,
    task.description ? `<details>${task.description}</details>` : null,
    task.estimatedMinutes ? `<total_estimate_minutes>${task.estimatedMinutes}</total_estimate_minutes>` : null,
    dueLabel ? `<due>${dueLabel}</due>` : null,
    "Break it into steps.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type ProposedStep = {
  title: string;
  minutes: number;
  /** ISO, end of the local day the step should be done by. Null when the task has no due date. */
  dueAt: string | null;
};

function cleanTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").replace(/^\d+[.)]\s*/, "").trim().slice(0, 120);
  return t.length >= 2 ? t : null;
}

const round5 = (m: number) => Math.max(5, Math.round(m / 5) * 5);

/**
 * Validates and finishes the model's steps. Throws when fewer than two usable
 * steps remain. Minutes are scaled to the task's estimate when it has one.
 */
export function finishBreakdown(
  wire: BreakdownWire,
  task: Pick<Task, "title" | "dueAt" | "estimatedMinutes">,
  ctx: { now: Date; timeZone: string },
): ProposedStep[] {
  const seen = new Set<string>();
  const steps = BreakdownWireSchema.parse(wire)
    .steps.map((s) => ({ title: cleanTitle(s.title), minutes: Math.min(MAX_STEP_MINUTES, Math.max(MIN_STEP_MINUTES, Math.round(s.minutes))) }))
    .filter((s): s is { title: string; minutes: number } => {
      if (!s.title || Number.isNaN(s.minutes)) return false;
      const key = s.title.toLowerCase();
      if (seen.has(key) || key === task.title.toLowerCase()) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_STEPS);
  if (steps.length < MIN_STEPS) throw new Error("Not enough usable steps.");

  // Steps add up to the task's own estimate: the user's number wins over the model's.
  if (task.estimatedMinutes && task.estimatedMinutes > 0) {
    const total = steps.reduce((s, x) => s + x.minutes, 0);
    const scale = task.estimatedMinutes / total;
    for (const s of steps) s.minutes = Math.min(MAX_STEP_MINUTES, Math.max(MIN_STEP_MINUTES, round5(s.minutes * scale)));
  } else {
    for (const s of steps) s.minutes = round5(s.minutes);
  }

  const dues = spreadDueDates(steps.length, task.dueAt, ctx);
  return steps.map((s, i) => ({ ...s, dueAt: dues[i] }));
}

/**
 * Evenly spaced local days from tomorrow (or today, when it's due that soon)
 * to the task's due day; the last step is due with the task itself.
 */
export function spreadDueDates(count: number, dueAt: string | null, ctx: { now: Date; timeZone: string }): (string | null)[] {
  if (!dueAt) return Array.from({ length: count }, () => null);
  const tz = ctx.timeZone;
  const today = dateKeyInZone(ctx.now, tz);
  const dueDay = dateKeyInZone(new Date(dueAt), tz);
  const span = Math.max(0, daysBetweenKeys(today, dueDay));
  return Array.from({ length: count }, (_, i) => {
    if (i === count - 1) return dueAt;
    // Step i finishes after (i + 1) / count of the time, never before today.
    const offset = Math.floor((span * (i + 1)) / count);
    const day = addDaysToKey(today, Math.min(span, offset));
    const end = zonedToUtc(day, "23:59", tz).toISOString();
    return Date.parse(end) > Date.parse(dueAt) ? dueAt : end;
  });
}
