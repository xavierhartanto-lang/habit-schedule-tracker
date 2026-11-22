import { normalizeText } from "@/lib/ai/extraction";
import type { Clarify } from "@/features/assistant/plan-types";
import type { ActionSpec, Assessment } from "./assess";
import { MAX_ASKS_PER_FIELD } from "./drafts";
import type { Draft, Intent, IntentType } from "./intents";
import { STRONG, nameScore, nameTokens } from "./resolve";

/**
 * Conversation action state. Pure, unit tested.
 *
 * One thing the user is trying to get done ("add math tutoring tomorrow at
 * 5") is ONE action, however many messages it takes. An action keeps what
 * is known, what is still missing, the card it produced and what happened
 * to that card. Follow-ups and corrections merge into the action instead of
 * starting over, and a corrected card replaces the old one by action id.
 *
 *   collecting  Whitespace is asking for something it needs.
 *   proposed    On an approval card, not saved.
 *   saved       The database confirmed it (applied).
 *   rejected    The user dismissed the card.
 *   failed      Saving failed; nothing changed.
 *   abandoned   Called off, expired, or replaced.
 *
 * The database is the source of truth: `syncActions` reads the real status
 * of each action's plan items every turn. Nothing here claims success.
 */

export type ActionStatus = "collecting" | "proposed" | "saved" | "rejected" | "failed" | "abandoned";

export type ActionContext = Draft & {
  status: ActionStatus;
  updatedAt: string;
  /** Plan items that currently represent this action (the latest card). */
  itemIds: string[];
  planId: string | null;
  /** The user's words that changed it after it was first understood, oldest first. */
  corrections: string[];
  /** One line describing it as it stands: "Math Tutoring · Thu Nov 19, 5:00 PM-6:00 PM". */
  summary: string | null;
  /** Saved record ids once applied (event or task id). */
  resultIds: string[];
  /** What went wrong, for failed actions. */
  error: string | null;
  /** Identity of what it creates, for duplicate prevention (see fingerprint). */
  fingerprint: string | null;
  /** The existing record it changes (task or event id). Refs like "e3" change every turn; ids don't. */
  targetId: string | null;
};

/** Open actions plus recently finished ones, newest first, never more than this. */
export const MAX_ACTIONS = 8;
/** Asking for details expires after a day. */
export const COLLECTING_TTL_MS = 24 * 60 * 60 * 1000;
/** A card is open at most this long (plans go stale after 24h). */
export const PROPOSED_TTL_MS = 24 * 60 * 60 * 1000;
/** Finished actions stay this long, so "it", "that" and repeats are understood. */
export const FINISHED_TTL_MS = 6 * 60 * 60 * 1000;

const OPEN: ReadonlySet<ActionStatus> = new Set(["collecting", "proposed"]);
export const isOpen = (a: ActionContext) => OPEN.has(a.status);

let counter = 0;
export function newActionId(): string {
  counter = (counter + 1) % 1000;
  return `a${Math.random().toString(36).slice(2, 8)}${counter}`;
}

/**
 * Reads conversations.planning_state. Older rows only had `drafts`
 * (unfinished intents): those become collecting actions.
 */
export function readActions(raw: unknown): ActionContext[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const state = raw as Record<string, unknown>;
  const list = Array.isArray(state.actions) ? state.actions : Array.isArray(state.drafts) ? state.drafts : [];
  const out: ActionContext[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Partial<ActionContext>;
    if (typeof a.id !== "string" || !a.intent || typeof a.createdAt !== "string") continue;
    out.push({
      id: a.id,
      intent: a.intent,
      asked: Array.isArray(a.asked) ? a.asked.filter((x): x is string => typeof x === "string") : [],
      createdAt: a.createdAt,
      status: a.status && ["collecting", "proposed", "saved", "rejected", "failed", "abandoned"].includes(a.status) ? a.status : "collecting",
      updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : a.createdAt,
      itemIds: Array.isArray(a.itemIds) ? a.itemIds.filter((x): x is string => typeof x === "string") : [],
      planId: typeof a.planId === "string" ? a.planId : null,
      corrections: Array.isArray(a.corrections) ? a.corrections.filter((x): x is string => typeof x === "string").slice(-5) : [],
      summary: typeof a.summary === "string" ? a.summary : null,
      resultIds: Array.isArray(a.resultIds) ? a.resultIds.filter((x): x is string => typeof x === "string") : [],
      error: typeof a.error === "string" ? a.error : null,
      fingerprint: typeof a.fingerprint === "string" ? a.fingerprint : null,
      targetId: typeof a.targetId === "string" ? a.targetId : null,
    });
  }
  return out;
}

/**
 * The database caps planning_state at 16 KB, and a write over it fails the
 * whole turn. Stay well under: drop the oldest finished actions first.
 */
export const STATE_BUDGET_CHARS = 10_000;

export function writeActions(actions: ActionContext[]): { actions: ActionContext[] } {
  const kept = [...actions];
  const size = () => JSON.stringify({ actions: kept }).length;
  while (kept.length > 1 && size() > STATE_BUDGET_CHARS) {
    let drop = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!isOpen(kept[i])) {
        drop = i;
        break;
      }
    }
    kept.splice(drop === -1 ? kept.length - 1 : drop, 1);
  }
  return { actions: kept };
}

export type ItemState = { id: string; status: string; error: string | null; resultId: string | null; targetId: string | null };

const REPLACED = "Replaced by a newer suggestion.";

/**
 * Brings each action in line with the database: a card the user approved
 * is saved only when its items are applied; a dismissed card is rejected;
 * a failed save is failed with the reason.
 */
export function syncActions(actions: ActionContext[], items: ItemState[], now: Date): ActionContext[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return actions.map((a) => {
    if (a.status !== "proposed" && a.status !== "failed") return a;
    const mine = a.itemIds.map((id) => byId.get(id)).filter((i): i is ItemState => !!i);
    if (!mine.length) return a;
    const statuses = mine.map((i) => i.status);
    const at = now.toISOString();
    if (statuses.some((s) => s === "pending" || s === "conflict")) {
      return a.status === "proposed" ? a : { ...a, status: "proposed", error: null, updatedAt: at };
    }
    if (statuses.every((s) => s === "applied")) {
      return {
        ...a,
        status: "saved",
        error: null,
        resultIds: mine.map((i) => i.resultId ?? i.targetId).filter((x): x is string => !!x),
        updatedAt: at,
      };
    }
    if (statuses.some((s) => s === "applied")) {
      const failed = mine.find((i) => i.status === "failed");
      return {
        ...a,
        status: "saved",
        error: failed?.error ?? null,
        resultIds: mine.filter((i) => i.status === "applied").map((i) => i.resultId ?? i.targetId).filter((x): x is string => !!x),
        updatedAt: at,
      };
    }
    const failed = mine.find((i) => i.status === "failed");
    if (failed) return { ...a, status: "failed", error: failed.error ?? "Couldn't save it.", updatedAt: at };
    if (statuses.every((s) => s === "undone")) return { ...a, status: "abandoned", error: "Undone by the user.", updatedAt: at };
    if (mine.every((i) => i.status === "rejected" && i.error === REPLACED)) return { ...a, status: "abandoned", updatedAt: at };
    return { ...a, status: "rejected", updatedAt: at };
  });
}

/** Drops expired actions and keeps the list short: open ones first, then the newest. */
export function pruneActions(actions: ActionContext[], now: Date): ActionContext[] {
  const t = now.getTime();
  const alive = actions.filter((a) => {
    const age = t - Date.parse(a.updatedAt || a.createdAt);
    if (a.status === "collecting") return t - Date.parse(a.createdAt) < COLLECTING_TTL_MS;
    if (a.status === "proposed") return age < PROPOSED_TTL_MS;
    return age < FINISHED_TTL_MS;
  });
  const open = alive.filter(isOpen);
  const done = alive.filter((a) => !isOpen(a)).sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
  return [...open, ...done].slice(0, MAX_ACTIONS);
}

// ---------------------------------------------------------------------------
// Corrections the model didn't link
// ---------------------------------------------------------------------------

const CORRECTION_CUE = /^(no|nope|actually|wait|sorry|oh|and|also it'?s|it'?s|its|that'?s|thats|make (that|it)|change (that|it)|i meant|i mean|instead|only|just)\b/i;
const NEW_THING_CUE = /\b(another|also have|one more|a second|plus)\b/i;

/** Words that tie two names to the same activity ("Tutoring Session" and "Math Tutoring" share "tutor"). */
function words(title: string | null): Set<string> {
  return new Set(nameTokens(title));
}

/**
 * The model normally links a follow-up to its action itself. When it
 * doesn't, a message that reads as a correction ("It's math tutoring",
 * "Actually Saturday") and is about the same kind of thing as exactly one
 * open action is linked here. Anything that reads as a new thing ("I also
 * have…", "another…") is left alone. Returns the action id or null.
 */
export function linkCorrection(intent: Intent, userText: string, actions: ActionContext[]): string | null {
  if (intent.draftId) return null;
  // "Move that to 6" right after a card for a new event: that's the card, not a saved event.
  if (intent.type === "update_event") {
    const creating = actions.filter((a) => isOpen(a) && a.intent.type === "create_event");
    if (creating.length !== 1) return null;
    const words = intent.targetName;
    const pronoun = !words || /^(it|that|this|the one|that one|this one)$/i.test(words.trim());
    const named = !!words && nameScore(words, creating[0].intent.title ?? "") >= STRONG;
    // A ref the model picked from saved records only counts when the user named it.
    if (intent.targetRef && !named) return null;
    return pronoun || named ? creating[0].id : null;
  }
  if (intent.targetRef) return null;
  if (!intent.type.startsWith("create_") && intent.type !== "plan_time") return null;
  if (NEW_THING_CUE.test(userText)) return null;
  const open = actions.filter((a) => isOpen(a) && a.intent.type === intent.type);
  if (!open.length) return null;
  const cue = CORRECTION_CUE.test(userText.trim());
  const mine = words(intent.title);
  const related = open.filter((a) => {
    const theirs = words(a.intent.title);
    return [...mine].some((w) => theirs.has(w));
  });
  if (related.length === 1 && (cue || !intent.date)) return related[0].id;
  // "Actually Saturday": no title of its own, one open action of that kind, and it reads as a correction.
  if (!intent.title && cue && open.length === 1) return open[0].id;
  return null;
}

// ---------------------------------------------------------------------------
// Advancing actions after a turn
// ---------------------------------------------------------------------------

export type ReadyAction = { actionId: string; spec: ActionSpec; explicit: boolean; intent: Intent };

export type Advance = {
  actions: ActionContext[];
  /** The single question to ask now (one at a time). */
  clarify: Clarify | null;
  givenUp: string[];
  /** Intents with everything they need, each tied to its action. */
  ready: ReadyAction[];
  /** Plan items whose card a correction or a cancel replaces. */
  supersede: string[];
  /** Actions the user called off that were on a card (reject those items). */
  cancelledItems: string[];
};

/**
 * Applies one turn's assessments to the action list. A follow-up keeps its
 * action id, so a corrected card replaces the old one instead of adding a
 * second. Questions are asked once per field (twice at most), never again
 * after the answer is known.
 */
export function advanceActions(
  previous: ActionContext[],
  turn: { consumed: string[]; cancelled: string[]; assessments: Assessment[]; userText: string },
  now: Date,
): Advance {
  const at = now.toISOString();
  const byId = new Map(previous.map((a) => [a.id, a]));
  const touched = new Set<string>();
  const out: Advance = { actions: [], clarify: null, givenUp: [], ready: [], supersede: [], cancelledItems: [] };
  const fresh: ActionContext[] = [];

  for (const id of turn.cancelled) {
    const a = byId.get(id);
    if (!a) continue;
    touched.add(id);
    if (a.status === "proposed") out.cancelledItems.push(...a.itemIds);
    fresh.push({ ...a, status: "abandoned", itemIds: a.status === "proposed" ? a.itemIds : [], updatedAt: at });
  }

  for (const assessment of turn.assessments) {
    if (assessment.status === "skip") continue;
    const prior = assessment.intent.draftId ? byId.get(assessment.intent.draftId) : undefined;
    const id = prior?.id ?? newActionId();
    if (touched.has(id)) continue;
    touched.add(id);
    const intent = { ...assessment.intent, draftId: id };
    // Answers to our questions fill gaps; changes to a card are corrections.
    const corrections = prior ? (prior.status === "proposed" ? [...prior.corrections, turn.userText].slice(-5) : prior.corrections) : [];
    // A correction to something on a card: the old card goes once the new one exists.
    if (prior?.status === "proposed") out.supersede.push(...prior.itemIds);
    const base: ActionContext = {
      id,
      intent,
      asked: prior?.asked ?? [],
      createdAt: prior?.createdAt ?? at,
      status: "collecting",
      updatedAt: at,
      itemIds: [],
      planId: null,
      corrections,
      summary: prior?.summary ?? null,
      resultIds: [],
      error: null,
      fingerprint: null,
      targetId: prior?.targetId ?? null,
    };

    if (assessment.status === "needs") {
      const asked = [...base.asked, assessment.clarify.field];
      if (asked.filter((f) => f === assessment.clarify.field).length > MAX_ASKS_PER_FIELD) {
        out.givenUp.push(assessment.clarify.about);
        fresh.push({ ...base, asked, status: "abandoned" });
        continue;
      }
      fresh.push({ ...base, asked });
      out.clarify ??= assessment.clarify;
      continue;
    }

    fresh.push({ ...base, fingerprint: fingerprint(assessment.spec), targetId: targetIdOf(assessment.spec) ?? base.targetId });
    out.ready.push({ actionId: id, spec: assessment.spec, explicit: intent.explicit, intent });
  }

  // Consumed drafts with no surviving intent (merged into another, or dropped) close quietly.
  for (const id of turn.consumed) {
    if (touched.has(id)) continue;
    const a = byId.get(id);
    if (a && a.status === "collecting") {
      touched.add(id);
      fresh.push({ ...a, status: "abandoned", updatedAt: at });
    }
  }

  const untouched = previous.filter((a) => !touched.has(a.id));
  out.actions = pruneActions([...fresh, ...untouched], now);
  return out;
}

/**
 * After the plan is stored: tie each ready action to the items it produced.
 * Auto-applied items count as saved only when the database says applied.
 */
export function attachItems(
  actions: ActionContext[],
  ready: ReadyAction[],
  items: { id: string; actionId: string | null; status: string; resultId: string | null; targetId: string | null; error: string | null }[],
  planId: string | null,
  summaries: Map<string, string>,
  now: Date,
): ActionContext[] {
  const readyIds = new Set(ready.map((r) => r.actionId));
  const at = now.toISOString();
  return actions.map((a) => {
    if (!readyIds.has(a.id)) return a;
    const mine = items.filter((i) => i.actionId === a.id);
    const summary = summaries.get(a.id) ?? a.summary;
    if (!mine.length) {
      // Nothing to show (already booked, nothing matched): the action is over.
      return { ...a, status: "abandoned", planId, summary, updatedAt: at };
    }
    const synced = syncActions(
      [{ ...a, status: "proposed", itemIds: mine.map((i) => i.id), planId, summary, updatedAt: at }],
      mine.map((i) => ({ id: i.id, status: i.status, error: i.error, resultId: i.resultId, targetId: i.targetId })),
      now,
    );
    return synced[0];
  });
}

// ---------------------------------------------------------------------------
// Duplicate prevention
// ---------------------------------------------------------------------------

/** The existing record a spec changes, if any. */
export function targetIdOf(spec: ActionSpec): string | null {
  switch (spec.kind) {
    case "task_update":
    case "task_complete":
    case "task_remove":
      return spec.task.id;
    case "event_update":
      return spec.event.id;
    case "remove_event":
      return spec.events[0]?.id ?? null;
    case "habit_update":
      return spec.habit.id;
    case "goal_update":
      return spec.goal.id;
    case "plan_time":
      return spec.taskId;
    case "finished_early":
      return spec.task?.id ?? null;
    case "cant_make":
      return spec.event?.id ?? spec.blocks[0]?.id ?? null;
    default:
      return null;
  }
}

/** What makes two creations "the same": kind, canonical name and when. */
export function fingerprint(spec: ActionSpec): string | null {
  const name = (t: string) => nameTokens(t).sort().join("+");
  switch (spec.kind) {
    case "event":
      return `event:${name(spec.title)}:${spec.date}:${spec.startTime}:${spec.rrule ?? "once"}`;
    case "task_create":
      return `task:${name(spec.title)}:${spec.dueDate ?? ""}${spec.repeat ? `:${spec.repeat}` : ""}`;
    case "habit_create":
      return `habit:${name(spec.title)}`;
    case "goal_create":
      return `goal:${name(spec.title)}`;
    default:
      return null;
  }
}

/** A finished or open action in this conversation that already does exactly this. */
export function sameAs(actions: ActionContext[], spec: ActionSpec, exceptId: string): ActionContext | null {
  const fp = fingerprint(spec);
  if (!fp) return null;
  return actions.find((a) => a.id !== exceptId && a.fingerprint === fp && (a.status === "saved" || a.status === "proposed")) ?? null;
}

// ---------------------------------------------------------------------------
// Prompt lines
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<ActionStatus, string> = {
  collecting: "still asking",
  proposed: "on an approval card, NOT saved yet",
  saved: "saved (confirmed by the database)",
  rejected: "dismissed by the user, nothing saved",
  failed: "save FAILED, nothing changed",
  abandoned: "dropped",
};

function known(i: Intent): string {
  const fields = Object.entries({
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
    target_ref: i.targetRef,
    scope: i.scope,
  })
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return fields || "nothing yet";
}

/** For the planner: what is in progress, so follow-ups merge instead of starting over. */
export function actionLine(a: ActionContext, savedRef?: string | null): string {
  const type: IntentType = a.intent.type;
  const parts = [`${a.id} (${type}, ${STATUS_TEXT[a.status]})`];
  if (a.summary) parts.push(`card: ${a.summary}`);
  parts.push(`known: ${known(a.intent)}`);
  if (a.status === "collecting") parts.push(`last asked about: ${a.asked.at(-1) ?? "nothing"}`);
  if (a.status === "saved" && savedRef) parts.push(`saved record: ${savedRef}`);
  if (a.error) parts.push(`error: ${a.error}`);
  return parts.join("; ");
}

/** For the reply model: what really happened, in plain words. */
export function stateLine(a: ActionContext): string {
  const what = a.summary ?? a.intent.title ?? a.intent.type.replace("_", " ");
  switch (a.status) {
    case "collecting":
      return `- ${what}: still collecting details (asked about ${a.asked.at(-1) ?? "something"}).`;
    case "proposed":
      return `- ${what}: waiting on the user's approval card. Not saved.`;
    case "saved":
      return `- ${what}: saved.${a.error ? ` Part of it failed: ${a.error}` : ""}`;
    case "rejected":
      return `- ${what}: the user dismissed it. Nothing saved.`;
    case "failed":
      return `- ${what}: saving failed (${a.error ?? "unknown error"}). Nothing changed.`;
    case "abandoned":
      return `- ${what}: dropped. Nothing saved.`;
  }
}

/** Same activity name, ignoring case, shorthand and word order. */
export function sameThing(a: string, b: string): boolean {
  if (normalizeText(a) === normalizeText(b)) return true;
  const x = nameTokens(a).sort().join("+");
  return !!x && x === nameTokens(b).sort().join("+");
}
