import "server-only";

import type { UserContext } from "@/lib/ai/context";
import { buildUserContext } from "@/lib/ai/context-builder";
import { localDateKey } from "@/lib/ai/context-helpers";
import type { KnownFactRef } from "@/lib/ai/extraction";
import { onboardingCoverage, type KnownFact, type OnboardingCoverage, type PromptContext } from "@/lib/ai/prompts";
import type { Commitment, ContextItem } from "@/lib/domain/types";

/**
 * Turns the user's saved context (built by the data layer, which already
 * respects the personalization and memory toggles) into what the AI layer
 * needs: the prompt context, the list of known facts for de-duplication,
 * and onboarding coverage for the progress indicator.
 */

export type ChatContext = {
  prompt: PromptContext;
  known: KnownFactRef[];
  coverage: OnboardingCoverage;
  timezone: string;
  today: { date: string; weekday: string };
  permissions: { personalization: boolean; memory: boolean };
  onboardedAt: string | null;
};

const BYDAY: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
const ITEM_DAY: Record<string, string> = { mo: "Mon", tu: "Tue", we: "Wed", th: "Thu", fr: "Fri", sa: "Sat", su: "Sun" };

function localTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function commitmentDetail(c: Commitment, timeZone: string): string | null {
  const parts: string[] = [];
  const byday = c.recurrenceRule?.match(/BYDAY=([A-Z,]+)/)?.[1];
  if (byday) parts.push(byday.split(",").map((d) => BYDAY[d] ?? d).join("/"));
  if (c.kind === "fixed" && c.startsAt && c.endsAt) {
    parts.push(`${localTime(c.startsAt, timeZone)}-${localTime(c.endsAt, timeZone)}`);
    if (!byday) parts.push(`on ${c.startsAt.slice(0, 10)}`);
  }
  if (c.kind === "flexible") parts.push("flexible");
  if (c.location) parts.push(`at ${c.location}`);
  if (c.notes) parts.push(c.notes);
  return parts.length ? parts.join(" ") : null;
}

function itemDetail(item: ContextItem): string | null {
  const a = item.attributes;
  const parts: string[] = [];
  if (a.days?.length) parts.push(a.days.map((d) => ITEM_DAY[d]).join("/"));
  if (a.startTime || a.endTime) parts.push([a.startTime, a.endTime].filter(Boolean).join("-"));
  if (a.timesPerWeek) parts.push(`${a.timesPerWeek}x a week`);
  if (a.durationMinutes) parts.push(`${a.durationMinutes} min`);
  if (item.details) parts.push(item.details);
  return parts.length ? parts.join(" ") : null;
}

export function toKnownFacts(ctx: UserContext): KnownFact[] {
  const tz = ctx.profile.timezone;
  const facts: KnownFact[] = [];
  for (const c of [...ctx.commitments.fixed, ...ctx.commitments.flexible]) {
    facts.push({ category: "commitment", title: c.title, area: c.area ?? "personal", detail: commitmentDetail(c, tz) });
  }
  for (const g of ctx.goals) {
    const detail = [g.horizon === "long_term" ? "long term" : g.horizon === "short_term" ? "short term" : null, g.targetDate ? `by ${g.targetDate}` : null, g.description]
      .filter(Boolean)
      .join(", ");
    facts.push({ category: "goal", title: g.title, area: g.area ?? "personal", detail: detail || null });
  }
  for (const items of Object.values(ctx.facts)) {
    for (const item of items) {
      // Items without a life area still count as known facts; "personal" is only a display bucket for the model.
      facts.push({ category: item.category, title: item.title, area: item.area ?? "personal", detail: itemDetail(item) });
    }
  }
  return facts;
}

function todayIn(timeZone: string, now: Date): { date: string; weekday: string } {
  let weekday: string;
  try {
    weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  } catch {
    weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(now);
  }
  return { date: localDateKey(now, timeZone), weekday };
}

export async function loadChatContext(
  userId: string,
  options: { conversationId?: string; now?: Date } = {},
): Promise<ChatContext> {
  const now = options.now ?? new Date();
  const ctx = await buildUserContext(userId, { excludeConversationId: options.conversationId, now });
  const facts = toKnownFacts(ctx);
  const today = todayIn(ctx.profile.timezone, now);

  return {
    prompt: {
      profile: ctx.profile,
      preferences: { dayStartTime: ctx.preferences.dayStartTime, dayEndTime: ctx.preferences.dayEndTime },
      facts,
      personalizationEnabled: ctx.permissions.personalization,
      today,
    },
    known: facts.map((f) => ({ category: f.category, title: f.title })),
    coverage: onboardingCoverage(facts),
    timezone: ctx.profile.timezone,
    today,
    permissions: ctx.permissions,
    onboardedAt: ctx.onboardedAt,
  };
}
