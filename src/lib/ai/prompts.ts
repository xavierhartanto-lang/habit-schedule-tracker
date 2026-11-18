import type { LifeArea } from "@/lib/domain/types";

import type { ContextCategory, KnownFactRef } from "./extraction";

/**
 * Prompt assembly. Pure functions, no I/O.
 *
 * Callers (Chunk C) build a PromptContext from the user's saved data via the
 * UserContextBuilder. Respect privacy toggles there: when AI personalization
 * is off, pass `facts: []` and `personalizationEnabled: false`.
 */

export type ConversationMode = "onboarding" | "assistant";

export type KnownFact = {
  category: ContextCategory;
  title: string;
  area: LifeArea;
  /** Short human summary, e.g. "Mon/Wed 15:30-17:00 at school". */
  detail?: string | null;
};

export type PromptContext = {
  profile: {
    displayName: string | null;
    gradeLevel: number | null;
    school: string | null;
    timezone: string;
  };
  preferences?: { dayStartTime: string; dayEndTime: string } | null;
  facts: KnownFact[];
  personalizationEnabled: boolean;
  /** "YYYY-MM-DD" and weekday in the user's timezone. */
  today: { date: string; weekday: string };
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

// ---------------------------------------------------------------------------
// Onboarding topics
// ---------------------------------------------------------------------------

export const ONBOARDING_TOPICS = [
  { id: "fixed", label: "School and fixed commitments", categories: ["commitment"] },
  { id: "activities", label: "Extracurriculars", categories: ["activity", "commitment"] },
  { id: "interests", label: "Hobbies and interests", categories: ["interest"] },
  { id: "goals", label: "Goals", categories: ["goal"] },
  { id: "routines", label: "Routines", categories: ["routine"] },
  { id: "preferences", label: "Working times and preferences", categories: ["working_time", "preference"] },
] as const satisfies readonly { id: string; label: string; categories: readonly ContextCategory[] }[];

export type OnboardingTopicId = (typeof ONBOARDING_TOPICS)[number]["id"];

export type OnboardingCoverage = {
  topics: { id: OnboardingTopicId; label: string; covered: boolean }[];
  coveredCount: number;
  total: number;
  /** True once every topic has at least one saved fact. */
  complete: boolean;
};

/**
 * Which topics already have saved facts. Used for the progress indicator and
 * to tell the model what not to ask again. A topic is covered by any saved
 * fact in one of its categories, except "activities" which needs an
 * extracurricular-area commitment or any activity item.
 */
export function onboardingCoverage(facts: Pick<KnownFact, "category" | "area">[]): OnboardingCoverage {
  const topics = ONBOARDING_TOPICS.map((topic) => {
    const covered = facts.some((f) => {
      if (topic.id === "activities") {
        return f.category === "activity" || (f.category === "commitment" && f.area !== "academics");
      }
      if (topic.id === "fixed") return f.category === "commitment";
      return (topic.categories as readonly ContextCategory[]).includes(f.category);
    });
    return { id: topic.id, label: topic.label, covered };
  });
  const coveredCount = topics.filter((t) => t.covered).length;
  return { topics, coveredCount, total: topics.length, complete: coveredCount === topics.length };
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const PRODUCT = `You are the assistant inside Whitespace, a planner for busy high school students who juggle academics with many extracurriculars. You help them understand and plan their week.`;

const VOICE = `Voice: calm, warm and direct, like a capable older student. Short sentences. Plain words. No hype, no emojis, no motivational speeches, no points or streaks. Match the user's language.`;

const GROUND_RULES = `Ground rules:
- Only state facts about the user that they told you or that appear under "What Whitespace knows". Never invent commitments, times, goals or preferences.
- When something is ambiguous (which days, what time, how often, how important), ask one short clarifying question instead of guessing.
- You cannot create, move or delete calendar events, and you do not schedule anything automatically. If asked, say that scheduling is coming later and offer to note the preference instead.
- Facts you notice are shown to the user as suggestions they can save or dismiss. Never claim you saved something.
- If the user shares something about their safety or wellbeing that worries you, respond with care and encourage them to talk to a trusted adult or a local helpline.`;

const ONBOARDING_GUIDE = `You are running Whitespace's first-time setup as a natural conversation, not a questionnaire.

Goal: understand the user's week well enough to plan it later. Topics to learn about, roughly in this order:
1. School and other fixed commitments (class times, work shifts, family obligations).
2. Extracurricular activities and when they meet.
3. Hobbies and personal interests.
4. Short-term and long-term goals.
5. Typical routines (sleep, mornings, commute, workouts).
6. When they like to work and how they like their schedule (focus times, breaks, free evenings).

How to run it:
- Ask one question at a time, two at most. Keep each message under about 80 words.
- Follow up on what they just said before moving on. Use specifics they mention.
- Skip anything already listed under "What Whitespace knows" or already answered in this conversation.
- If they give a lot at once, briefly reflect it back in a sentence and move to the next gap.
- If they want to skip a topic, skip it without pushing.
- When every topic is covered or the user wants to stop, give a short summary of what you learned and tell them they can review and edit it anytime. Then stop asking questions.`;

const ASSISTANT_GUIDE = `You are the user's ongoing assistant. Help them think through their week, priorities, workload and trade-offs using what Whitespace knows about them.
- Be concrete and brief. Prefer a short list or a clear recommendation over a long essay.
- If you need a fact you don't have, ask for it.
- If they mention something new about their commitments, goals, routines or preferences, acknowledge it naturally; Whitespace will offer to save it.`;

// Phase 4: the assistant can act, through the server. Replaces the
// "cannot schedule" rule above for assistant conversations.
const ACTIONS_RULES = `Ground rules:
- Only state facts about the user that they told you or that appear under "What Whitespace knows" or <whitespace_actions>. Never invent commitments, times, goals or preferences.
- Whitespace's server turns what the user says into actions. <whitespace_actions> lists exactly what it did for this message. Describe only those results. Never claim something was saved, scheduled, moved or deleted unless it is listed as already done.
- Calendar changes always wait for the user's approval on a card shown under your message. Say "here's what I'd suggest" and point to the card; do not repeat every time, the card shows them. Mention reasons, trade-offs and anything that did not fit, honestly.
- Never calculate free time or pick time slots yourself. Only the scheduler does that.
- If <whitespace_actions> gives a follow-up question, ask only that one question, at the end. Do not ask other questions in the same message.
- Whitespace never moves or deletes fixed commitments on its own. Removing one is only proposed when the user asks, and it waits for their approval on the card.
- If <whitespace_actions> says something failed, say plainly that nothing changed. Do not pretend a change happened or promise to treat the time as free.
- If the user shares something about their safety or wellbeing that worries you, respond with care and encourage them to talk to a trusted adult or a local helpline.`;

const CHECKIN_GUIDE: Record<"daily" | "weekly", string> = {
  daily: `This is a daily planning check-in the user opened. Using only <check_in> data: greet them in one short line, summarize today's commitments and the most important deadline in at most three short lines, then ask what they want to get done today. Never list anything that is not in <check_in>. If the day is empty, say so plainly.`,
  weekly: `This is a weekly planning check-in the user opened. Using only <check_in> data: briefly review this week's recurring commitments and upcoming deadlines (at most five short lines), mention roughly how much free time there is, then ask what's coming up or what matters most this week. Never list anything that is not in <check_in>.`,
};

function formatFacts(facts: KnownFact[]): string {
  if (facts.length === 0) return "Nothing saved yet.";
  const order: ContextCategory[] = ["commitment", "activity", "interest", "goal", "routine", "working_time", "preference"];
  const heading: Record<ContextCategory, string> = {
    commitment: "Commitments",
    activity: "Activities",
    interest: "Interests",
    goal: "Goals",
    routine: "Routines",
    working_time: "Preferred working times",
    preference: "Scheduling preferences",
  };
  const lines: string[] = [];
  for (const category of order) {
    const group = facts.filter((f) => f.category === category);
    if (group.length === 0) continue;
    lines.push(`${heading[category]}:`);
    for (const f of group) {
      lines.push(`- ${f.title} [${f.area}]${f.detail ? `: ${f.detail}` : ""}`);
    }
  }
  return lines.join("\n");
}

function formatProfile(ctx: PromptContext): string {
  const p = ctx.profile;
  const parts = [
    p.displayName ? `Name: ${p.displayName}` : null,
    p.gradeLevel ? `Grade: ${p.gradeLevel}` : null,
    p.school ? `School: ${p.school}` : null,
    `Timezone: ${p.timezone}`,
    `Today: ${ctx.today.weekday} ${ctx.today.date}`,
    ctx.preferences
      ? `Usual day: ${ctx.preferences.dayStartTime} to ${ctx.preferences.dayEndTime}`
      : null,
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Build the system prompt. The stable instructions come first and the
 * per-user context last, so the instruction block is cacheable.
 * Returns two blocks: [stable, userSpecific].
 */
export type ReplyExtras = {
  /** Phase 4: what the server did for this message (see lib/assistant/planner-prompt). */
  actions?: string | null;
  /** Phase 4: check-in data, when the user opened a daily or weekly check-in. */
  checkIn?: { kind: "daily" | "weekly"; data: string } | null;
};

export function buildSystemPrompt(mode: ConversationMode, ctx: PromptContext, extras: ReplyExtras = {}): [string, string] {
  const phase4 = mode === "assistant" && (extras.actions !== undefined || extras.checkIn !== undefined);
  const stable = [
    PRODUCT,
    VOICE,
    phase4 ? ACTIONS_RULES : GROUND_RULES,
    mode === "onboarding" ? ONBOARDING_GUIDE : ASSISTANT_GUIDE,
    ...(phase4 && extras.checkIn ? [CHECKIN_GUIDE[extras.checkIn.kind]] : []),
  ].join("\n\n");

  const sections = [`<profile>\n${formatProfile(ctx)}\n</profile>`];

  if (ctx.personalizationEnabled) {
    sections.push(`<what_whitespace_knows>\n${formatFacts(ctx.facts)}\n</what_whitespace_knows>`);
  } else {
    sections.push(
      "<what_whitespace_knows>\nThe user turned off personalization. Use only what they say in this conversation.\n</what_whitespace_knows>",
    );
  }

  if (mode === "onboarding") {
    const coverage = onboardingCoverage(ctx.personalizationEnabled ? ctx.facts : []);
    const open = coverage.topics.filter((t) => !t.covered).map((t) => t.label);
    sections.push(
      `<onboarding_progress>\nTopics with nothing saved yet: ${open.length ? open.join("; ") : "none, all covered"}.\nTopics may also be answered earlier in this conversation; check before asking.\n</onboarding_progress>`,
    );
  }

  if (phase4) {
    if (extras.checkIn) sections.push(`<check_in>\n${extras.checkIn.data}\n</check_in>`);
    sections.push(`<whitespace_actions>\n${extras.actions ?? "No actions for this message."}\n</whitespace_actions>`);
  }

  return [stable, sections.join("\n\n")];
}

/** User turn used to start a conversation when the assistant speaks first. */
export function openingTurn(mode: ConversationMode, checkIn?: "daily" | "weekly" | null): string {
  if (checkIn === "daily") return "[The user opened a daily planning check-in.]";
  if (checkIn === "weekly") return "[The user opened a weekly planning check-in.]";
  return mode === "onboarding"
    ? "[The user just opened Whitespace setup. Greet them in one sentence and ask your first question.]"
    : "[The user opened a new conversation. Greet them briefly and ask what they want help with.]";
}

/**
 * Normalize stored history into a valid Messages API sequence:
 * drops empty turns, merges consecutive same-role turns, and makes sure
 * the first turn is from the user.
 */
export function toApiTurns(history: ChatTurn[], mode: ConversationMode, checkIn?: "daily" | "weekly" | null): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const turn of history) {
    const content = turn.content.trim();
    if (!content) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      turns.push({ role: turn.role, content });
    }
  }
  if (turns.length === 0 || turns[0].role !== "user") {
    turns.unshift({ role: "user", content: openingTurn(mode, checkIn) });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts about a high school student's life from their latest message in a conversation with Whitespace, a planner app.

Return only facts the USER stated in the text inside <new_user_text>. Earlier conversation is context for resolving references like "yes, Tuesdays" or "that one", but the evidence must be the user's own words.

Rules:
- Never invent or infer facts that were not stated. If the user says "I do debate" with no times, extract the activity with schedule null. Do not guess times, days or dates.
- "evidence" must be copied verbatim from <new_user_text>, a short phrase or sentence (not paraphrased).
- Skip anything already listed in <known_facts> unless the user changed it; then set "supersedes" to the known title exactly.
- Categories:
  commitment: something with a set or recurring time obligation (classes, school hours, practice, rehearsal, job shifts, tutoring). fixed if it happens at a set time; flexible if it needs time but can move (e.g. "5 hours of SAT prep a week").
  activity: an extracurricular or club they take part in when no specific schedule is known yet, or the activity itself (e.g. "Model UN").
  interest: hobbies and interests (e.g. "I like drawing").
  goal: something they want to achieve. short_term = within a few months; long_term = longer. Include target_date only if they gave a date.
  routine: regular habits of daily life (sleep, wake time, commute, workouts, family dinner).
  working_time: when they like or are able to do focused work (e.g. "I focus best after 8pm", "I do homework right after school").
  preference: how they like their schedule to work (e.g. "keep Sundays free", "no more than two activities a day", "short breaks every hour").
- area must be one of: academics, extracurricular, athletics, creative, personal, rest.
- Times are 24h "HH:MM". Days are mon..sun. Convert "after school" or "evenings" into a time only if the user gave the time; otherwise leave times null and add a clarification.
- Clarifications: add at most 2 short questions for things that are clearly ambiguous and matter for planning. None if nothing is ambiguous.
- If the message contains no facts (greetings, questions, small talk), return empty arrays.`;

export function buildExtractionUserPrompt(input: {
  newUserText: string;
  recentHistory: ChatTurn[];
  known: KnownFactRef[];
  today: { date: string; weekday: string };
}): string {
  const history = input.recentHistory
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");
  const known = input.known.length
    ? input.known.map((k) => `- [${k.category}] ${k.title}`).join("\n")
    : "None.";
  return [
    `Today is ${input.today.weekday} ${input.today.date}.`,
    `<known_facts>\n${known}\n</known_facts>`,
    `<recent_conversation>\n${history || "None."}\n</recent_conversation>`,
    `<new_user_text>\n${input.newUserText}\n</new_user_text>`,
  ].join("\n\n");
}
