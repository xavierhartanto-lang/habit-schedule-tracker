import type { Clarify } from "@/features/assistant/plan-types";
import type { Assessment } from "./assess";
import { MAX_DRAFTS, type Draft } from "./intents";

/**
 * Follow-up bookkeeping: which question to ask now (one at a time), which
 * unfinished intents to keep, and when to stop asking. Pure, unit tested.
 */

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** Ask about the same missing field at most this many times, then stop. */
export const MAX_ASKS_PER_FIELD = 2;

function draftId(): string {
  return `d${Math.random().toString(36).slice(2, 10)}`;
}

/** Picks the follow-up to ask (one at a time) and keeps the rest as drafts. */
export function nextDrafts(
  previous: Draft[],
  consumed: string[],
  assessments: Assessment[],
  now: Date,
): { drafts: Draft[]; clarify: Clarify | null; givenUp: string[] } {
  const keep = previous.filter((d) => !consumed.includes(d.id) && now.getTime() - Date.parse(d.createdAt) < DRAFT_TTL_MS);
  const byId = new Map(previous.map((d) => [d.id, d]));
  const fresh: Draft[] = [];
  const givenUp: string[] = [];
  let clarify: Clarify | null = null;
  for (const a of assessments) {
    if (a.status !== "needs") continue;
    const prior = a.intent.draftId ? byId.get(a.intent.draftId) : undefined;
    const asked = [...(prior?.asked ?? []), a.clarify.field];
    if (asked.filter((f) => f === a.clarify.field).length > MAX_ASKS_PER_FIELD) {
      givenUp.push(a.clarify.about);
      continue;
    }
    const id = prior?.id ?? draftId();
    fresh.push({ id, intent: { ...a.intent, draftId: id }, asked, createdAt: prior?.createdAt ?? now.toISOString() });
    clarify ??= a.clarify;
  }
  const drafts = [...fresh, ...keep].slice(0, MAX_DRAFTS);
  return { drafts, clarify, givenUp };
}

