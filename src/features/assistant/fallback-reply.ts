import type { PlanView } from "./plan-types";

/**
 * The assistant's reply when the AI can't write one (no key, outage) but the
 * server still built a plan from a proactive button. Plain, honest, and only
 * about what the plan actually contains. Pure, so it is tested.
 */
export function fallbackReply(input: { plan: PlanView | null; failed: string | null }): string {
  if (input.failed) return `${input.failed} Nothing on your calendar changed.`;
  const plan = input.plan;
  if (!plan) return "I couldn't put together a change for that right now. Nothing on your calendar changed.";

  const pending = plan.items.filter((i) => i.status === "pending" || i.status === "conflict");
  const lines: string[] = [];
  if (pending.length) {
    lines.push(
      pending.length === 1
        ? "Here's what I'd suggest. Nothing changes until you approve it below."
        : `Here are ${pending.length} changes I'd suggest. Nothing changes until you approve them below.`,
    );
  } else {
    lines.push("I couldn't find a change that fits right now, so nothing is waiting for approval.");
  }
  if (plan.unscheduled.length) {
    const short = plan.unscheduled
      .slice(0, 2)
      .map((u) => `${u.title} (${u.minutes} min short)`)
      .join(", ");
    lines.push(`Not everything fit: ${short}.`);
  }
  return lines.join(" ");
}
