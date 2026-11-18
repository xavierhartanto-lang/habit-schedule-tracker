import { z } from "zod";
import type { Task, Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import type { SchedulingPreferences } from "./preferences";
import type { PlanAmount, PlanRequest } from "./types";

/**
 * What the AI asks the engine to place. Validate LLM output with
 * planRequestSchema before planning: the engine never guesses a missing
 * duration or day.
 */

export const REQUEST_LIMITS = {
  singleMinutes: [5, 720],
  totalMinutes: [5, 3000],
  sessionCount: [1, 21],
  sessionMinutes: [5, 480],
  avoid: 100,
} as const;

const zIso = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Use a valid date and time.");

function zMinutes(label: string, [min, max]: readonly [number, number]) {
  return z
    .number({ error: `${label} must be a number of minutes.` })
    .int(`${label} must be whole minutes.`)
    .min(min, `${label} must be at least ${min} minutes.`)
    .max(max, `${label} must be at most ${max} minutes.`);
}

const zAmount = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single"), minutes: zMinutes("Duration", REQUEST_LIMITS.singleMinutes) }),
  z.object({ type: z.literal("total"), minutes: zMinutes("Total time", REQUEST_LIMITS.totalMinutes) }),
  z.object({
    type: z.literal("sessions"),
    count: z
      .number({ error: "Session count must be a number." })
      .int("Session count must be whole.")
      .min(REQUEST_LIMITS.sessionCount[0], "Ask for at least one session.")
      .max(REQUEST_LIMITS.sessionCount[1], `At most ${REQUEST_LIMITS.sessionCount[1]} sessions.`),
    minutesEach: zMinutes("Session length", REQUEST_LIMITS.sessionMinutes),
  }),
]);

const zRef = z.string().max(100).nullish().transform((v) => v || null);

export const planRequestSchema = z.object({
  id: z.string().trim().min(1, "A request id is required.").max(100),
  title: z
    .string({ error: "A title is required." })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .refine((v) => v.length >= 1 && v.length <= 200, "A title is required (max 200 characters)."),
  amount: zAmount,
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  deadline: zIso.nullish().transform((v) => v ?? null),
  earliestStart: zIso.nullish().transform((v) => v ?? null),
  preferredDays: z
    .array(z.enum(WEEKDAYS as unknown as [Weekday, ...Weekday[]]))
    .max(7)
    .optional()
    .transform((v) => (v?.length ? WEEKDAYS.filter((d) => v.includes(d)) : [])),
  avoid: z
    .array(z.object({ start: zIso, end: zIso }))
    .max(REQUEST_LIMITS.avoid)
    .optional()
    .transform((v) => v ?? []),
  lifeAreaId: zRef,
  taskId: zRef,
  habitId: zRef,
  goalId: zRef,
});

export type ValidPlanRequest = z.output<typeof planRequestSchema>;

/** Total minutes a request asks for. */
export function requestedMinutes(amount: PlanAmount): number {
  return amount.type === "sessions" ? amount.count * amount.minutesEach : amount.minutes;
}

/**
 * Session lengths for a request.
 * single   = one block.
 * sessions = exactly what was asked.
 * total    = even sessions no longer than maxSessionMinutes, in 5-minute steps.
 */
export function sessionSizes(
  amount: PlanAmount,
  prefs: Pick<SchedulingPreferences, "minSessionMinutes" | "maxSessionMinutes">,
): number[] {
  if (amount.type === "single") return [amount.minutes];
  if (amount.type === "sessions") return Array.from({ length: amount.count }, () => amount.minutesEach);
  const total = amount.minutes;
  if (total <= prefs.maxSessionMinutes) return [total];
  let n = Math.ceil(total / prefs.maxSessionMinutes);
  if (total / n < prefs.minSessionMinutes) n = Math.max(1, Math.floor(total / prefs.minSessionMinutes));
  return evenSplit(total, n);
}

/** `total` split into `n` parts in 5-minute steps (largest first). */
export function evenSplit(total: number, n: number): number[] {
  const base = Math.floor(total / n / 5) * 5;
  const sizes = Array.from({ length: n }, () => base);
  let rest = total - base * n;
  for (let i = 0; rest > 0; i = (i + 1) % n) {
    const add = Math.min(5, rest);
    sizes[i] += add;
    rest -= add;
  }
  return sizes.sort((a, b) => b - a);
}

/**
 * A request for an open task that has a time estimate, due by its due
 * date. Returns null when there is nothing to schedule or no estimate
 * (ask the user how long it takes instead of guessing).
 */
export function requestFromTask(task: Task): PlanRequest | null {
  if (task.status === "done" || !task.estimatedMinutes || task.estimatedMinutes < 5) return null;
  return {
    id: `task:${task.id}`,
    title: task.title,
    amount: { type: "total", minutes: Math.min(task.estimatedMinutes, REQUEST_LIMITS.totalMinutes[1]) },
    priority: task.priority,
    deadline: task.dueAt,
    lifeAreaId: task.lifeAreaId ?? null,
    taskId: task.id,
    goalId: task.goalId ?? null,
  };
}
