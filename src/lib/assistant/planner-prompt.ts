import { formatFacts, type ChatTurn, type KnownFact, type PromptContext } from "@/lib/ai/prompts";
import type { Commitment, LifeAreaRecord } from "@/lib/domain/types";
import { parseRRule, describeRecurrence } from "@/lib/scheduling/recurrence";
import { dateKeyInZone, timeKeyInZone } from "@/lib/scheduling/zoned";
import type { PlanView } from "@/features/assistant/plan-types";
import type { RefTable } from "./assess";
import { calendarTable, clockLabel, shortDate } from "./dates";
import type { Draft } from "./intents";
import type { NamingContext } from "./naming";

/**
 * Prompts for the planner (structured intents) and the extra context the
 * reply model gets about what the server actually did. Pure.
 */

export const PLANNER_SYSTEM_PROMPT = `You turn a high school student's latest chat message into structured intents for Whitespace, a planner app. You do not reply to the user and you never change data yourself: the server validates every intent, asks follow-up questions, and the user approves calendar changes.

Rules
- Only use what the USER said in <new_user_text>, plus <pending_drafts> it answers. Never invent days, times, durations, amounts or deadlines. Leave unknown fields empty: "" for text, -1 for numbers, "none" for choices, and an all-empty date. The server asks for them one at a time.
- "evidence" is copied verbatim from <new_user_text>.
- Dates: never compute a calendar date. Fill date.weekday ("fr"), date.week ("next" only if the user said "next Friday"/"next week"), or date.day_offset (0 today, 1 tomorrow). Use iso_date only when the user typed a calendar date like "Dec 3"; use <calendar> to write it as YYYY-MM-DD.
- Times are 24h "HH:MM". Students mean afternoon/evening for "at 6" activities (18:00) and "at 3" after school (15:00) unless they say am.
- Recurrence: "every Thursday" = weekly + days [th]; "every weekday" = weekdays; "every day" = daily; "this Thursday"/"next Thursday"/a calendar date = once. If the user only said "on Thursday" for an activity, leave recurrence "none".
- Follow-ups: if <new_user_text> answers or corrects a pending draft ("Thursday", "every week", "about 2 hours", "actually 7pm"), return that draft's type with draft_id set and ONLY the new or changed fields filled. Say "never mind" → type cancel_draft with that draft_id.
- Existing records: use their refs from <current_plan> in target_ref (t = task, e = event, b = session Whitespace scheduled, h = habit, g = goal).
- explicit = true only when the user directly asks Whitespace to do the action now ("add a task to…", "mark my essay done", "set my goal to 50%"). Statements like "I have a test Friday" are explicit=false.

Choosing a type
- create_event: something at a set time (class, practice, game, exam, appointment, "school until 3 every weekday" = weekdays, start_time empty if unknown).
- create_task: a to-do or assignment. plan_time: the user wants time found for work ("I need 3 hours to study this week", "practice piano twice"); amount_kind total/sessions/single. Do not invent session lengths: set session_minutes only if stated.
- One message can hold several intents: "chem exam next Friday, need 3 hours to study, piano twice" = create_event (exam, date fr/next, no time yet) + plan_time (study, amount_kind total 180, deadline fr/next) + plan_time (piano, sessions, session_count 2).
- create_habit / update_habit: repeated personal practice the user wants to track ("start exercising twice a week" = create_habit weekly times_per_week 2). If they also want it on the calendar, add plan_time.
- create_goal / update_goal (progress 0-100, target_date).
- set_life_area: "put robotics under Extracurriculars".
- update_preferences: "don't schedule anything after 9pm" (pref_day_end 21:00), "keep 6-7 for dinner" (pref_protected_label Dinner, start_time 18:00, end_time 19:00), "max 1 hour sessions".
- save_fact: lasting facts without a time slot: activities, interests, routines, working times, preferences that are not scheduling rules.
- remove_event: the user wants an existing event gone for good ("cancel all math tutoring", "I quit robotics, take it off", "delete the dentist appointment"). Set target_ref to the event's e/b ref from <current_plan>, and title in the user's words. explicit = true when they ask directly. For one skipped day of a repeating event use cant_make instead.
- remove_task: the user wants an existing task (a to-do, not a calendar event) deleted ("delete my essay task", "take the chem worksheet off my list", "cancel training" when training is a t ref and no e/b ref matches). Set target_ref to the task's t ref, and title in the user's words. If they finished it, use complete_task instead.
- Before choosing remove_event, check the t refs too: "cancel", "remove" or "delete" a name that is only a task means remove_task. For "it" or "that", use the item named in the recent conversation.
- cant_make: "I can't study Wednesday anymore" or "no tutoring this Wednesday" (date + title, or target_ref). finished_early: "I finished my coding project early". not_enough_time: "I don't think I'll have enough time this week".
- Greetings, questions about their schedule, small talk: return no intents.
- question: only for real ambiguity the fields cannot express (e.g. it is unclear whether "work on my coding project" means a one-time task or regular time). Otherwise "".

Naming (title and details)
The user describes their life casually. You turn it into the name they would want to see on their calendar.
- title: concise, specific, professional, natural title case, easy to scan. Usually 1 to 4 words, a noun phrase, never a sentence. No first person ("I", "my"), filler, leading articles, dates, times, durations or how often it repeats: those go in their own fields.
  "I have to tutor a kid tomorrow" -> "Tutoring Session". "Basketball after school" -> "Basketball Practice". "Need to finish my chem hw" -> "Chemistry Homework". "Meeting with the DECA people" -> "DECA Meeting". "Helping Jack study for his test" -> "Study Session with Jack".
- Use context to be specific: <what_whitespace_knows> (onboarding answers, activities, interests, commitments, goals, past conversations), <current_plan>, <life_areas> and the recent conversation.
  If the user is known to tutor math, "tutor a kid" -> "Math Tutoring". If they have an app or project with a name, "work on my app" -> "<that name> Development" (e.g. "HoopVision Development"). Expand clear shorthand ("chem" = Chemistry, "hw" = Homework).
- Never invent specifics. A subject, person, place, project name, objective, duration, deadline or recurrence goes in only if the user said it or it is established above. With no known subject, "tutor a kid" stays "Tutoring Session", not "Math Tutoring". When unsure, pick an accurate general title instead of asking. Never ask a question just to get a better name.
- Keep what the user already made specific: "Finish my AP Chemistry lab report" -> "AP Chemistry Lab Report".
- Consistency: if the activity already exists in <current_plan> or <what_whitespace_knows>, use that exact name, even if the user calls it something shorter ("basketball" -> the existing "Basketball Practice"). The same activity keeps one name everywhere.
- plan_time for an existing task: set target_ref to that task. Whitespace names the sessions after the task, so they stay linked.
- details: one short description sentence for extra specifics that do not belong in the title, from the user's words or established context ("Tutoring an elementary-school student in math."). "" when there is nothing useful. Never put guesses here either.
- Titles of save_fact preferences, routines and working times can keep their times ("Focus after 8pm").`;

function eventLine(e: Commitment, timeZone: string): string {
  if (!e.startsAt || !e.endsAt) return `${e.title} (flexible, no time yet)`;
  const s = new Date(e.startsAt);
  const time = `${clockLabel(timeKeyInZone(s, timeZone))}-${clockLabel(timeKeyInZone(new Date(e.endsAt), timeZone))}`;
  const rule = parseRRule(e.recurrenceRule);
  const when = rule ? describeRecurrence(rule) : shortDate(dateKeyInZone(s, timeZone));
  return `${e.title}: ${when}, ${time}${e.kind === "fixed" ? "" : " (flexible)"}`;
}

export function formatRefs(refs: RefTable, timeZone: string): string {
  const lines: string[] = [];
  for (const [ref, t] of refs.tasks) {
    const bits = [
      t.dueAt ? `due ${shortDate(dateKeyInZone(new Date(t.dueAt), timeZone))}` : null,
      t.estimatedMinutes ? `${t.estimatedMinutes} min` : null,
      t.priority !== "medium" ? t.priority : null,
    ].filter(Boolean);
    lines.push(`${ref} task: ${t.title}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  for (const [ref, e] of refs.events) lines.push(`${ref} event: ${eventLine(e, timeZone)}`);
  for (const [ref, b] of refs.blocks) lines.push(`${ref} session Whitespace scheduled: ${eventLine(b, timeZone)}`);
  for (const [ref, h] of refs.habits) lines.push(`${ref} habit: ${h.title}`);
  for (const [ref, g] of refs.goals) lines.push(`${ref} goal: ${g.title}${typeof g.progress === "number" ? ` (${g.progress}%)` : ""}`);
  return lines.length ? lines.join("\n") : "Nothing yet.";
}

function draftLine(d: Draft): string {
  const i = d.intent;
  const known = Object.entries({
    title: i.title,
    date: i.date,
    start_time: i.startTime,
    end_time: i.endTime,
    duration_minutes: i.durationMinutes,
    recurrence: i.recurrence,
    days: i.days.length ? i.days : null,
    amount_minutes: i.amountMinutes,
    session_count: i.sessionCount,
    deadline: i.deadline,
  })
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${d.id} (${i.type}): ${known || "nothing yet"}; last asked about: ${d.asked.at(-1) ?? "nothing"}`;
}

/**
 * What Whitespace knows about the user, for naming. Comes from the same
 * context builder as the reply model, so the privacy toggles already apply:
 * personalization off means no facts and no conversation recaps.
 */
export type PlannerKnowledge = {
  personalizationEnabled: boolean;
  profile: Pick<PromptContext["profile"], "gradeLevel" | "school">;
  facts: KnownFact[];
  /** Recaps of recent conversations, e.g. "College essays: drafted the Common App essay outline." */
  recaps: string[];
};

export function formatKnowledge(knowledge: PlannerKnowledge | null | undefined): string {
  if (!knowledge) return "Nothing available.";
  if (!knowledge.personalizationEnabled) {
    return "The user turned off personalization. Name things from their own words and <current_plan> only.";
  }
  const profile = [
    knowledge.profile.gradeLevel ? `Grade ${knowledge.profile.gradeLevel}` : null,
    knowledge.profile.school ? `School: ${knowledge.profile.school}` : null,
  ].filter(Boolean);
  const parts = [
    profile.length ? profile.join(". ") : null,
    formatFacts(knowledge.facts),
    knowledge.recaps.length ? `Recent conversations:\n${knowledge.recaps.map((r) => `- ${r}`).join("\n")}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

/** Everything a new title may draw on, and the names already in use. */
export function namingContext(input: {
  refs: RefTable;
  areas: LifeAreaRecord[];
  recentHistory: ChatTurn[];
  knowledge?: PlannerKnowledge | null;
}): NamingContext {
  const k = input.knowledge?.personalizationEnabled ? input.knowledge : null;
  const recordNames = [
    ...[...input.refs.tasks.values()].map((t) => t.title),
    ...[...input.refs.events.values()].map((e) => e.title),
    ...[...input.refs.blocks.values()].map((b) => b.title),
    ...[...input.refs.habits.values()].map((h) => h.title),
    ...[...input.refs.goals.values()].map((g) => g.title),
  ];
  const factNames = (k?.facts ?? []).filter((f) => f.category === "commitment" || f.category === "activity").map((f) => f.title);
  return {
    sources: [
      ...input.recentHistory.map((t) => t.content),
      ...recordNames,
      ...input.areas.map((a) => a.name),
      ...(k?.facts ?? []).map((f) => `${f.title} ${f.detail ?? ""}`),
      ...(k?.recaps ?? []),
      ...(k?.profile.school ? [k.profile.school] : []),
    ],
    knownNames: [...new Set([...recordNames, ...factNames])],
  };
}

export function buildPlannerUserPrompt(input: {
  todayKey: string;
  weekday: string;
  timeZone: string;
  areas: LifeAreaRecord[];
  refs: RefTable;
  drafts: Draft[];
  recentHistory: ChatTurn[];
  newUserText: string;
  knowledge?: PlannerKnowledge | null;
}): string {
  const history = input.recentHistory.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n");
  return [
    `Today is ${input.weekday} ${input.todayKey}. Time zone: ${input.timeZone}. Weeks start on Monday.`,
    `<calendar>\n${calendarTable(input.todayKey)}\n</calendar>`,
    `<what_whitespace_knows>\n${formatKnowledge(input.knowledge)}\n</what_whitespace_knows>`,
    `<life_areas>\n${input.areas.map((a) => a.name).join(", ") || "None"}\n</life_areas>`,
    `<current_plan>\n${formatRefs(input.refs, input.timeZone)}\n</current_plan>`,
    `<pending_drafts>\n${input.drafts.map(draftLine).join("\n") || "None."}\n</pending_drafts>`,
    `<recent_conversation>\n${history || "None."}\n</recent_conversation>`,
    `<new_user_text>\n${input.newUserText}\n</new_user_text>`,
  ].join("\n\n");
}

/**
 * Tells the reply model exactly what happened, so it explains real results
 * and never claims something was saved or scheduled when it was not.
 */
export function plannerResultBlock(input: {
  plan: PlanView | null;
  question: string | null;
  notes: string[];
  failed: string | null;
}): string | null {
  const lines: string[] = [];
  if (input.failed) lines.push(`Whitespace could not process actions for this message: ${input.failed}. Nothing was changed.`);
  const plan = input.plan;
  if (plan) {
    const applied = plan.items.filter((i) => i.autoApplied && i.status === "applied");
    const pending = plan.items.filter((i) => i.status === "pending" || i.status === "conflict");
    if (applied.length) {
      lines.push("Already done (the user asked for these directly):");
      for (const i of applied) lines.push(`- ${i.action.replace("_", " ")}: ${i.title}${i.detail ? ` (${i.detail})` : ""}`);
    }
    if (pending.length) {
      lines.push("Shown to the user on an approval card below your message (NOT saved until they approve):");
      for (const i of pending) {
        const when = i.timing ? ` ${shortDate(i.timing.date)} ${clockLabel(i.timing.startTime)}-${clockLabel(i.timing.endTime)}${i.timing.recurrence ? `, ${i.timing.recurrence}` : ""}` : "";
        const extra = [i.detail, i.conflicts.length ? `conflicts with ${i.conflicts.map((c) => c.title).join(", ")}` : null]
          .filter(Boolean)
          .join("; ");
        lines.push(`- ${i.action.replace("_", " ")}: ${i.title}${when}${extra ? ` (${extra})` : ""}`);
      }
    }
    if (plan.summary) lines.push(`Scheduler summary: ${plan.summary}`);
    if (plan.unscheduled.length) {
      lines.push("Could not fit (say so honestly, do not pretend it fits):");
      for (const u of plan.unscheduled) lines.push(`- ${u.title}: ${u.minutes} min short. ${u.reason}`);
    }
  }
  for (const n of input.notes) lines.push(`Note: ${n}`);
  if (input.question) lines.push(`Ask exactly this one follow-up question, in your own words, at the end: "${input.question}"`);
  if (!lines.length) return null;
  return lines.join("\n");
}
