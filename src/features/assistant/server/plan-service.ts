import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { ChatTurn } from "@/lib/ai/prompts";
import { interpretMessage } from "@/lib/ai/service";
import { normalizeText } from "@/lib/ai/extraction";
import {
  advanceActions,
  attachItems,
  isOpen,
  linkCorrection,
  pruneActions,
  sameAs,
  syncActions,
  type ActionContext,
} from "@/lib/assistant/action-state";
import { assessIntent, separateSharedTargets, occursOn, type Assessment, type KnownActivity, type RefTable, type World } from "@/lib/assistant/assess";
import { buildPlan, timingFor, type ItemDisplay } from "@/lib/assistant/build-plan";
import { clockLabel, shortDate } from "@/lib/assistant/dates";
import { dedupeIntents, mergeIntent, type Intent } from "@/lib/assistant/intents";
import { nameScore, nameTokens, isGenericToken } from "@/lib/assistant/resolve";
import { parsePayload, toOp, type Op } from "@/lib/assistant/ops";
import { buildPlannerUserPrompt, namingContext, plannerResultBlock, type PlannerKnowledge } from "@/lib/assistant/planner-prompt";
import { applyPreferenceChanges } from "@/lib/assistant/prefs";
import { sendApprovedEmail } from "@/features/google/server/mail";
import { DataValidationError } from "@/lib/db/client";
import { linkSessionsToTask, markPastSessionsDone } from "@/lib/db/events";
import { listGoals } from "@/lib/db/goals";
import { listActiveHabits } from "@/lib/db/habits";
import { listLifeAreas } from "@/lib/db/life-areas";
import {
  applyPlanItems,
  createPlan,
  getActions,
  getItemStates,
  getPlan,
  listOpenItemsInConversation,
  listPendingBlocks,
  markAutoApplied,
  rejectItems,
  setActions,
  supersedeItems,
  toPlanView,
  undoPlanItem,
  updateOpenItem,
  type StoredItem,
  type StoredPlan,
} from "@/lib/db/plans";
import { getPreferences } from "@/lib/db/profiles";
import { loadSchedulingBase } from "@/lib/db/scheduling";
import { getSchedulingPreferences, saveSchedulingPreferences } from "@/lib/db/scheduling-preferences";
import type { Commitment } from "@/lib/domain/types";
import { checkPlacements, planSchedule, type PlanRequest, type SchedulingPreferences } from "@/lib/scheduling/planner";
import { addDaysToKey, dateKeyInZone, startOfDayInZone, timeKeyInZone } from "@/lib/scheduling/zoned";
import { removeGoogleEvent, undoGoogleChange, updateGoogleEvent, type GoogleScope, type GoogleUndo } from "@/features/google/server/writes";
import { CALENDAR_ACTIONS, type Clarify, type PlanItemOutcome, type PlanView } from "../plan-types";

/**
 * Phase 4 orchestration: message -> intents -> follow-up or plan -> approval.
 *
 *   planTurn        runs for every assistant chat message.
 *   approveItems    re-checks availability, then applies in one transaction.
 *   rejectItems / editItem / findAlternatives / undoItem
 *
 * Every database call runs as the signed-in user (RLS). The model never
 * writes data, and calendar items are never applied without approval.
 */

const REF_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// World: what the planner and the assessor see about the user
// ---------------------------------------------------------------------------

export type LoadedWorld = {
  world: World;
  events: Commitment[];
  openTasks: Awaited<ReturnType<typeof loadSchedulingBase>>["openTasks"];
  preferences: SchedulingPreferences;
};

export async function loadWorld(userId: string, now: Date): Promise<LoadedWorld> {
  // From a week back, so "clean up this week" also sees the days already gone by.
  const windowStart = new Date(now.getTime() - 8 * 86_400_000).toISOString();
  const windowEnd = new Date(now.getTime() + 62 * 86_400_000).toISOString();
  const [base, prefs, areas] = await Promise.all([
    loadSchedulingBase(userId, { start: windowStart, end: windowEnd }),
    getPreferences(userId),
    listLifeAreas(userId),
  ]);
  const timeZone = base.timeZone;
  const todayKey = dateKeyInZone(now, timeZone);
  const weekStartsOn = prefs?.weekStartsOn ?? 1;
  const [habits, goals] = await Promise.all([
    listActiveHabits(userId, { from: todayKey, to: todayKey }),
    listGoals(userId, { status: "active", limit: 50 }),
  ]);

  const refs: RefTable = { tasks: new Map(), events: new Map(), blocks: new Map(), habits: new Map(), goals: new Map() };
  base.openTasks.slice(0, 40).forEach((t, i) => refs.tasks.set(`t${i + 1}`, t));
  const horizon = now.getTime() + REF_WINDOW_DAYS * 86_400_000;
  let e = 0;
  let b = 0;
  for (const ev of base.events) {
    if (!ev.startsAt || !ev.endsAt) continue;
    const isBlock = ev.kind === "flexible" && !!ev.planItemId;
    const relevant = !!ev.recurrenceRule || (Date.parse(ev.endsAt) > now.getTime() && Date.parse(ev.startsAt) < horizon);
    if (!relevant) continue;
    if (isBlock) {
      if (Date.parse(ev.startsAt) > now.getTime() && b < 40) refs.blocks.set(`b${++b}`, ev);
    } else if (e < 60) {
      refs.events.set(`e${++e}`, ev);
    }
  }
  habits.slice(0, 30).forEach((h, i) => refs.habits.set(`h${i + 1}`, h));
  goals.slice(0, 30).forEach((g, i) => refs.goals.set(`g${i + 1}`, g));

  return {
    world: { todayKey, timeZone, weekStartsOn, areas, refs, known: knownActivities(base.events, timeZone), nowTime: timeKeyInZone(now, timeZone) },
    events: base.events,
    openTasks: base.openTasks,
    preferences: base.preferences,
  };
}

function weekdayName(todayKey: string): string {
  return new Date(`${todayKey}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// One chat turn
// ---------------------------------------------------------------------------

export type PlanTurnResult = {
  plan: PlanView | null;
  clarify: Clarify | null;
  /** For the reply model: exactly what happened. */
  actions: string | null;
  /** Earlier cards this message changed (approved by "yes", replaced by a correction, cancelled), so they update live. */
  touched?: PlanView[];
};

/** Usual time and length of activities already on the calendar (repeating ones first). */
export function knownActivities(events: Commitment[], timeZone: string): KnownActivity[] {
  const out: KnownActivity[] = [];
  const seen = new Set<string>();
  const sorted = [...events].filter((e) => e.kind === "fixed" && e.startsAt && e.endsAt).sort((a, b) => Number(!!b.recurrenceRule) - Number(!!a.recurrenceRule));
  for (const e of sorted) {
    const key = nameTokens(e.title).sort().join("+");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tz = e.timezone ?? timeZone;
    out.push({
      title: e.title,
      startTime: timeKeyInZone(new Date(e.startsAt!), tz),
      durationMinutes: Math.round((Date.parse(e.endsAt!) - Date.parse(e.startsAt!)) / 60_000),
      source: "event",
    });
  }
  return out.slice(0, 60);
}

/** Ref of each record by id, for this turn's numbering. */
function refIndex(refs: RefTable): Map<string, string> {
  const out = new Map<string, string>();
  for (const map of [refs.tasks, refs.events, refs.blocks, refs.habits, refs.goals] as Map<string, { id: string }>[]) {
    for (const [ref, item] of map) if (!out.has(item.id)) out.set(item.id, ref);
  }
  return out;
}

function titleOf(refs: RefTable, ref: string): string | null {
  const item = refs.tasks.get(ref) ?? refs.events.get(ref) ?? refs.blocks.get(ref) ?? refs.habits.get(ref) ?? refs.goals.get(ref);
  return item?.title ?? null;
}

/**
 * What "it" / "that" can mean right now: records the latest actions touched
 * (newest first), then records named in the last few messages.
 */
export function focusRefs(refs: RefTable, actions: ActionContext[], recentText: string[]): string[] {
  const byId = refIndex(refs);
  const out: string[] = [];
  const add = (ref: string | undefined) => {
    if (ref && !out.includes(ref)) out.push(ref);
  };
  const recent = [...actions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const a of recent.slice(0, 3)) {
    for (const id of [...a.resultIds, a.targetId]) if (id) add(byId.get(id));
  }
  const words = new Set(nameTokens(recentText.join(" ")));
  for (const ref of byId.values()) {
    const title = titleOf(refs, ref);
    if (!title) continue;
    const tokens = nameTokens(title);
    const specific = tokens.filter((t) => !isGenericToken(t));
    const need = specific.length ? specific : tokens;
    if (need.length && need.every((t) => words.has(t))) add(ref);
  }
  return out.slice(0, 6);
}

const REMOVE_WORDS = /\b(clear|remove|delete|cancel|take (?:it|them|those) off)\b/i;

/**
 * Records the assistant's last message offered to remove: named in a sentence
 * that says clear/remove/delete, or in the sentence just before one
 * ("Biology Essay and Draft are still on tonight's calendar. Say the word and I'll clear them.").
 */
export function offeredRefs(refs: RefTable, lastReply: string): string[] {
  const sentences = lastReply.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const picked = sentences.filter((s, i) => REMOVE_WORDS.test(s) || (i + 1 < sentences.length && REMOVE_WORDS.test(sentences[i + 1]) && !/\b(?:it|this|that)\b/i.test(sentences[i + 1])));
  if (!picked.length) return [];
  const words = new Set(nameTokens(picked.join(" ")));
  const out: string[] = [];
  for (const ref of refIndex(refs).values()) {
    const title = titleOf(refs, ref);
    if (!title) continue;
    const tokens = nameTokens(title);
    const specific = tokens.filter((t) => !isGenericToken(t));
    const need = specific.length ? specific : tokens;
    if (need.length && need.every((t) => words.has(t)) && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/** Refs in an action's intent go stale when numbering changes; re-point them at today's refs. */
function remapTargets(actions: ActionContext[], refs: RefTable): ActionContext[] {
  const byId = refIndex(refs);
  return actions.map((a) => (a.targetId ? { ...a, intent: { ...a.intent, targetRef: byId.get(a.targetId) ?? null } } : a));
}

/** Deterministic request id for a chat approval, so a retried message never applies twice. */
function chatRequestId(messageId: string, planId: string): string {
  const hex = createHash("sha256").update(`chat-approve:${messageId}:${planId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One line for an action's card: "Math Tutoring · Thu Nov 19, 5:00 PM-6:00 PM". */
function cardSummary(items: { title: string; timing: ItemDisplay["timing"]; action: string }[]): string | null {
  const first = items[0];
  if (!first) return null;
  const t = first.timing;
  const when = t ? ` · ${shortDate(t.date)}, ${clockLabel(t.startTime)}-${clockLabel(t.endTime)}${t.recurrence ? `, ${t.recurrence}` : ""}` : "";
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : "";
  return `${first.action.replace("_", " ")}: ${first.title}${when}${more}`;
}

/**
 * Duplicate prevention: a creation that matches something already saved
 * (on the calendar, on the task list, or saved earlier in this chat) or
 * already on an open card does not get a second card.
 */
function duplicateNote(a: Assessment, actions: ActionContext[], loaded: LoadedWorld): string | null {
  if (a.status !== "ready") return null;
  const spec = a.spec;
  const twin = sameAs(actions, spec, a.intent.draftId ?? "");
  if (twin) {
    return twin.status === "saved"
      ? `"${twin.summary ?? spec.kind}" was already saved earlier in this conversation. Nothing new was added; say it's already there.`
      : `"${twin.summary ?? spec.kind}" is already on an approval card above. No second card was made; point to that one.`;
  }
  if (spec.kind === "event") {
    const tz = loaded.world.timeZone;
    const same = loaded.events.find(
      (e) =>
        e.startsAt &&
        nameScore(spec.title, e.title) >= 0.99 &&
        occursOn(e, spec.date, tz) &&
        timeKeyInZone(new Date(e.startsAt), e.timezone ?? tz) === spec.startTime,
    );
    if (same) return `${same.title} is already on the calendar on ${shortDate(spec.date)} at ${clockLabel(spec.startTime)}. Nothing new was added; say so.`;
  }
  if (spec.kind === "task_create") {
    const same = loaded.openTasks.find((t) => nameScore(spec.title, t.title) >= 0.99);
    if (same) return `"${same.title}" is already on the task list. No duplicate was added; say so.`;
  }
  return null;
}

/** A failed action is retried for an hour after it failed. */
const RETRY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Which failed actions a "yes" or "try again" means. A named action, or with
 * "latest" the newest failed one, but only when no card is waiting (then the
 * yes is for that card).
 */
export function retryTargets(confirmed: string[], actions: ActionContext[], now = new Date()): ActionContext[] {
  const recent = (a: ActionContext) => a.status === "failed" && now.getTime() - Date.parse(a.updatedAt) < RETRY_WINDOW_MS;
  const out: ActionContext[] = [];
  for (const id of confirmed) {
    if (id !== "latest") {
      const a = actions.find((x) => x.id === id && recent(x));
      if (a && !out.includes(a)) out.push(a);
      continue;
    }
    if (actions.some((a) => a.status === "proposed")) continue;
    const newest = actions.filter(recent).sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))[0];
    if (newest && !out.includes(newest)) out.push(newest);
  }
  return out;
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error };
  return { name: error.name, message: error.message, code: (error as { code?: unknown }).code };
}

export async function planTurn(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  userText: string;
  history: ChatTurn[];
  /** What Whitespace knows about the user, so new items get specific, consistent names. */
  knowledge?: PlannerKnowledge | null;
  signal?: AbortSignal;
  now?: Date;
}): Promise<PlanTurnResult> {
  const now = input.now ?? new Date();
  const [stored, loaded] = await Promise.all([getActions(input.userId, input.conversationId), loadWorld(input.userId, now)]);
  const { world } = loaded;

  // 1. Action state follows the database: approved cards are saved only when applied.
  const states = await getItemStates(input.userId, stored.flatMap((a) => a.itemIds));
  let actions = remapTargets(pruneActions(syncActions(stored, states, now), now), world.refs);
  const recentHistory = input.history.slice(-6);
  world.focus = focusRefs(world.refs, actions, [...recentHistory.slice(-4).map((t) => t.content), input.userText]);
  // "I told you to clear them a while ago": the newest recent reply that offered a removal.
  world.offered = [...recentHistory]
    .reverse()
    .filter((t) => t.role === "assistant")
    .map((t) => offeredRefs(world.refs, t.content))
    .find((refs) => refs.length) ?? [];
  const byRecord = refIndex(world.refs);
  const savedRefs = new Map(
    actions.flatMap((a) => (a.status === "saved" && a.resultIds[0] && byRecord.has(a.resultIds[0]) ? [[a.id, byRecord.get(a.resultIds[0])!] as const] : [])),
  );
  const continuable = actions.filter(isOpen);

  // 2. Understand the message (model), then validate it (server).
  const interpreted = await interpretMessage({
    userMessage: input.userText,
    drafts: continuable,
    signal: input.signal,
    naming: namingContext({ refs: world.refs, areas: world.areas, recentHistory, knowledge: input.knowledge }),
    prompt: buildPlannerUserPrompt({
      todayKey: world.todayKey,
      weekday: weekdayName(world.todayKey),
      timeZone: world.timeZone,
      areas: world.areas,
      refs: world.refs,
      actions,
      savedRefs,
      recentHistory,
      newUserText: input.userText,
      knowledge: input.knowledge,
    }),
  });
  if (interpreted.dropped.length) console.info("[plan] dropped intents", interpreted.dropped);
  if (interpreted.retitled.length) console.info("[plan] unsupported title details removed", interpreted.retitled);

  // 3. Corrections the model didn't link ("It's math tutoring") still join their action.
  const consumed = [...interpreted.consumedDrafts];
  const intents: Intent[] = dedupeIntents(interpreted.intents).map((intent) => {
    const linked = linkCorrection(intent, input.userText, actions);
    if (!linked) return intent;
    const action = actions.find((a) => a.id === linked)!;
    consumed.push(linked);
    return { ...mergeIntent(action.intent, intent), draftId: linked };
  });
  // The user picked from our own "which one?" options: trust that pick.
  const prepared: Intent[] = intents.map((intent) => {
    const prior = intent.draftId ? actions.find((a) => a.id === intent.draftId) : undefined;
    return prior?.asked.at(-1) === "target" && intent.targetRef ? { ...intent, targetConfirmed: true } : intent;
  });

  // "Yes" / "try again" after a save failed: rebuild that action's card from what it knew.
  const retry = retryTargets(interpreted.confirmed, actions, now);
  for (const a of retry) {
    if (!prepared.some((i) => i.draftId === a.id)) prepared.push({ ...a.intent, draftId: a.id, targetConfirmed: a.intent.targetRef ? true : a.intent.targetConfirmed });
  }
  const reapprove = new Set(retry.filter((a) => a.itemIds.length).map((a) => a.id));
  interpreted.confirmed = interpreted.confirmed.filter((id) => !retry.some((a) => a.id === id) && !(id === "latest" && retry.length));

  const notes: string[] = [];
  const touchedPlanIds = new Set<string>();

  // "Undo that" / "put it back": reverse the newest change Whitespace made in this chat.
  if (interpreted.intents.some((i) => i.type === "undo")) {
    const undone = await undoNewest(input.userId, actions, now);
    if (undone) {
      touchedPlanIds.add(undone.planId);
      const fresh = await getItemStates(input.userId, actions.flatMap((a) => a.itemIds));
      actions = syncActions(actions, fresh, now);
      notes.push(`Undid the last change: ${undone.titles.join(", ")}. It is back the way it was (the database confirmed it). Say so in a few words.`);
    } else {
      notes.push("There's nothing to undo in this conversation: no change Whitespace made here is still in place. Nothing was changed. Say so plainly.");
    }
  }

  const assessments = separateSharedTargets(prepared.map((intent) => assessIntent(intent, world)), world).map((a) => {
    const intent = a.intent;
    if (a.status === "skip" && a.note) notes.push(a.note);
    const dup = duplicateNote(a, actions, loaded);
    if (dup) {
      notes.push(dup);
      return { status: "skip" as const, intent, reason: "Duplicate." };
    }
    return a;
  });

  // 4. Approvals and cancels said in words. The database decides what happened.
  const approvedHere: string[] = [];
  if (interpreted.confirmed.length) {
    const targets = interpreted.confirmed.flatMap((id) => {
      if (id !== "latest") return actions.filter((a) => a.id === id && a.status === "proposed");
      const latest = actions.filter((a) => a.status === "proposed").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      return latest ? [latest] : [];
    });
    if (!targets.length) notes.push("The user said yes, but nothing is waiting for approval. Nothing was changed.");
    const byPlan = new Map<string, string[]>();
    for (const a of targets) if (a.planId) byPlan.set(a.planId, [...(byPlan.get(a.planId) ?? []), ...a.itemIds]);
    for (const [planId, itemIds] of byPlan) {
      touchedPlanIds.add(planId);
      try {
        const { results } = await approveItems(input.userId, planId, { itemIds, requestId: chatRequestId(input.userMessageId, planId), now });
        approvedHere.push(...targets.filter((a) => a.planId === planId).map((a) => a.id));
        const bad = results.filter((r) => r.outcome !== "applied" && r.outcome !== "already_applied");
        if (bad.length) notes.push(`Approved in chat, but not everything saved: ${bad.map((r) => r.message ?? r.outcome).join("; ")}.`);
      } catch (error) {
        console.error("[plan] chat approval failed", error);
        notes.push("The user approved in chat, but saving failed. Nothing changed. Say so and suggest tapping Approve on the card.");
      }
    }
  }

  const advance = advanceActions(actions, { consumed, cancelled: interpreted.cancelled, assessments, userText: input.userText }, now);
  actions = advance.actions;
  const givenUp = advance.givenUp.map((about) => `Stopped asking about ${about}; the user can add it from the calendar.`);
  notes.push(...givenUp);
  const clarify: Clarify | null =
    advance.clarify ?? (interpreted.question ? { about: "Your message", field: "other", question: interpreted.question, choices: [] } : null);

  // Cancelled cards close; corrected ones are replaced.
  for (const a of actions) {
    if (a.planId && a.itemIds.some((i) => advance.supersede.includes(i))) touchedPlanIds.add(a.planId);
  }
  for (const a of stored) if (a.planId && a.itemIds.some((i) => advance.supersede.includes(i))) touchedPlanIds.add(a.planId);
  for (const a of stored.filter((x) => interpreted.cancelled.includes(x.id) && x.status === "proposed" && x.planId)) {
    touchedPlanIds.add(a.planId!);
    await rejectItems(input.userId, a.planId!, a.itemIds).catch((error) => console.error("[plan] could not close card", error));
  }

  let plan: StoredPlan | null = null;
  if (advance.ready.length) {
    try {
      const busy = await listPendingBlocks(input.userId, { now });
      const built = buildPlan({
        now: now.toISOString(),
        world,
        preferences: loaded.preferences,
        events: loaded.events,
        openTasks: loaded.openTasks,
        busy,
        specs: advance.ready.map((r) => ({ spec: r.spec, explicit: r.explicit, actionId: r.actionId })),
        sourceMessageId: input.userMessageId,
      });
      notes.push(...built.notes);
      if (built.items.length || built.unscheduled.length) {
        plan = await createPlan(input.userId, {
          conversationId: input.conversationId,
          sourceMessageId: input.userMessageId,
          built,
          now,
        });
        // A corrected action replaces its old card (by action id), never adds a second one.
        await supersedeItems(input.userId, advance.supersede);
        await supersedeOlder(input.userId, input.conversationId, plan);
        // A retried action's old failed card closes, so it can't be approved twice.
        for (const a of retry.filter((x) => x.planId && x.itemIds.length)) {
          touchedPlanIds.add(a.planId!);
          await rejectItems(input.userId, a.planId!, a.itemIds).catch((error) => console.error("[plan] could not close failed card", error));
        }
        // Command and concur: what the user directly asked for applies right away,
        // with Undo. Calendar changes apply only when the user commanded exactly
        // that change; anything Whitespace proposes waits for Approve.
        const auto = plan.items
          .filter((i, idx) => built.items[idx]?.autoApply && (!CALENDAR_ACTIONS.has(i.action) || built.items[idx]?.commanded === true))
          .map((i) => i.id);
        if (auto.length) {
          const { results } = await approveItems(input.userId, plan.id, { itemIds: auto, requestId: randomUUID(), now });
          await markAutoApplied(
            input.userId,
            results.filter((r) => r.outcome === "applied").map((r) => r.itemId),
          );
        }
        plan = await getPlan(input.userId, plan.id);
      } else if (advance.supersede.length) {
        await supersedeItems(input.userId, advance.supersede);
      }
      const tagged = plan
        ? plan.items.map((item, idx) => ({ ...item, actionId: built.items[idx]?.actionId ?? null }))
        : [];
      const summaries = new Map<string, string>();
      for (const r of advance.ready) {
        const mine = tagged.filter((i) => i.actionId === r.actionId);
        const line = cardSummary(mine.map((i) => ({ title: i.title, timing: i.display.timing, action: i.action })));
        if (line) summaries.set(r.actionId, line);
      }
      actions = attachItems(
        actions,
        advance.ready,
        tagged.map((i) => ({ id: i.id, actionId: i.actionId, status: i.status, resultId: i.resultId, targetId: i.targetId, error: i.error })),
        plan?.id ?? null,
        summaries,
        now,
      );
      // The user already approved these once; the retry finishes the job.
      const again = plan ? tagged.filter((i) => i.actionId && reapprove.has(i.actionId) && i.status === "pending") : [];
      if (plan && again.length) {
        touchedPlanIds.add(plan.id);
        const { results } = await approveItems(input.userId, plan.id, { itemIds: again.map((i) => i.id), requestId: chatRequestId(input.userMessageId, plan.id), now });
        approvedHere.push(...new Set(again.map((i) => i.actionId!)));
        const bad = results.filter((r) => r.outcome !== "applied" && r.outcome !== "already_applied");
        if (bad.length) notes.push(`Retried, but not everything saved: ${bad.map((r) => r.message ?? r.outcome).join("; ")}.`);
        plan = await getPlan(input.userId, plan.id);
      }
    } catch (error) {
      // Keep the action so "try again" can rebuild it. Nothing was saved.
      console.error("[plan] could not create the card", describeError(error));
      if (plan) touchedPlanIds.add(plan.id);
      plan = null;
      const failedIds = new Set(advance.ready.map((r) => r.actionId));
      actions = actions.map((a) =>
        failedIds.has(a.id) ? { ...a, status: "failed" as const, itemIds: [], planId: null, error: "storage error while preparing the card", updatedAt: now.toISOString() } : a,
      );
      notes.push(
        'Whitespace hit a storage error while preparing this, so no card was made and nothing changed. Say so in one line. The details are kept: if the user says "try again" or "yes", it is rebuilt.',
      );
    }
  }

  // Chat approvals: read back what the database did.
  if (approvedHere.length) {
    const fresh = await getItemStates(input.userId, actions.filter((a) => approvedHere.includes(a.id)).flatMap((a) => a.itemIds));
    actions = syncActions(actions, fresh, now);
    for (const a of actions.filter((x) => approvedHere.includes(x.id))) {
      notes.push(
        a.status === "saved"
          ? `The user approved "${a.summary ?? a.intent.title}" in chat. The database confirmed it is saved.`
          : `The user approved "${a.summary ?? a.intent.title}" in chat, but it was NOT saved${a.error ? `: ${a.error}` : ""}. Say so plainly.`,
      );
    }
  }

  await setActions(input.userId, input.conversationId, actions);
  const view = plan ? toPlanView(plan, now) : null;
  if (plan) touchedPlanIds.delete(plan.id);
  const touched: PlanView[] = [];
  for (const planId of touchedPlanIds) {
    const p = await getPlan(input.userId, planId).catch(() => null);
    if (p) touched.push(toPlanView(p, now));
  }
  const thisTurn = new Set([...advance.ready.map((r) => r.actionId), ...approvedHere]);
  return {
    plan: view,
    clarify,
    actions: plannerResultBlock({
      plan: view,
      question: clarify?.question ?? null,
      notes,
      failed: null,
      state: actions.filter((a) => !thisTurn.has(a.id)),
    }),
    touched,
  };
}

/**
 * Undoes every applied item of the newest action in this conversation that still
 * has something applied, newest item first. Returns what was undone, or null.
 */
async function undoNewest(userId: string, actions: ActionContext[], now: Date): Promise<{ planId: string; titles: string[] } | null> {
  const newest = [...actions].filter((a) => a.planId && a.itemIds.length).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const a of newest) {
    const plan = await getPlan(userId, a.planId!).catch(() => null);
    if (!plan) continue;
    const items = plan.items.filter((i) => a.itemIds.includes(i.id) && i.status === "applied" && i.undo);
    if (!items.length) continue;
    const titles: string[] = [];
    for (const item of [...items].reverse()) {
      try {
        await undoItem(userId, plan.id, item.id, now);
        titles.push(item.title);
      } catch (error) {
        console.error("[plan] undo failed", describeError(error));
      }
    }
    return titles.length ? { planId: plan.id, titles: [...new Set(titles)] } : null;
  }
  return null;
}

/** A correction ("actually it's at 7") replaces the earlier open suggestion for the same thing. */
async function supersedeOlder(userId: string, conversationId: string, plan: StoredPlan): Promise<void> {
  const keys = new Set(plan.items.map((i) => `${i.action}:${normalizeText(i.title)}`));
  const older = (await listOpenItemsInConversation(userId, conversationId)).filter(
    (i) => i.proposalId !== plan.id && keys.has(`${i.action}:${normalizeText(i.title)}`) && (i.action === "create_event" || i.action === "create_task" || i.action === "create_habit" || i.action === "create_goal"),
  );
  await supersedeItems(
    userId,
    older.map((i) => i.id),
  );
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ItemResult = { itemId: string; outcome: PlanItemOutcome; message?: string };

const TIMED: ReadonlySet<string> = new Set(["create_event", "schedule_block", "move_block", "update_event"]);
const BLOCKING: ReadonlySet<string> = new Set(["schedule_block", "move_block"]);
const OPEN: ReadonlySet<string> = new Set(["pending", "conflict", "failed"]);

function editTimes(item: StoredItem, edit: { start: string; end: string }, timeZone: string): { payload: Record<string, unknown>; display: ItemDisplay } {
  const start = Date.parse(edit.start);
  const end = Date.parse(edit.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new DataValidationError("The end time must be after the start time.");
  }
  if (end - start > 12 * 60 * 60 * 1000) throw new DataValidationError("Keep it under 12 hours.");
  if (!TIMED.has(item.action) || !item.display.editable) throw new DataValidationError("This suggestion can't be edited.");
  const s = new Date(start).toISOString();
  const e = new Date(end).toISOString();
  return {
    payload: { ...item.payload, startsAt: s, endsAt: e },
    display: {
      ...item.display,
      timing: timingFor(s, e, timeZone, { recurrence: item.display.timing?.recurrence ?? null }),
      reason: item.display.reason?.startsWith("Edited") ? item.display.reason : `Edited by you. ${item.display.reason ?? ""}`.trim(),
      conflicts: [],
      warnings: [],
    },
  };
}

/** Re-checks timed items against the calendar as it is right now. */
async function recheck(
  userId: string,
  items: StoredItem[],
  now: Date,
): Promise<Map<string, { conflicts: ItemDisplay["conflicts"]; warnings: string[] }>> {
  const out = new Map<string, { conflicts: ItemDisplay["conflicts"]; warnings: string[] }>();
  const timed = items.filter((i) => TIMED.has(i.action) && typeof i.payload.startsAt === "string");
  if (!timed.length) return out;
  const starts = timed.map((i) => Date.parse(String(i.payload.startsAt)));
  const ends = timed.map((i) => Date.parse(String(i.payload.endsAt)));
  const window = {
    start: new Date(Math.min(...starts, now.getTime()) - 86_400_000).toISOString(),
    end: new Date(Math.max(...ends) + 86_400_000).toISOString(),
  };
  const base = await loadSchedulingBase(userId, window);
  // An event being moved or changed never conflicts with its own old time.
  const moving = new Set(timed.filter((i) => i.action === "move_block" || i.action === "update_event").map((i) => String(i.payload.commitmentId)));
  const events = base.events.filter((e) => !moving.has(e.id));
  const placements = timed.map((i) => ({ id: i.id, start: String(i.payload.startsAt), end: String(i.payload.endsAt), title: i.title }));
  const checkIn = (w: { start: string; end: string }, list: typeof placements) =>
    checkPlacements({ now: now.toISOString(), timeZone: base.timeZone, window: w, events, preferences: base.preferences }, list).results;
  // The engine checks at most 62 days at a time, and an event can be months away
  // ("orientation on March 15"): then each item is checked in its own few days.
  const results =
    Date.parse(window.end) - Date.parse(window.start) <= 60 * 86_400_000
      ? checkIn(window, placements)
      : placements.flatMap((p) =>
          checkIn({ start: new Date(Date.parse(p.start) - 86_400_000).toISOString(), end: new Date(Date.parse(p.end) + 86_400_000).toISOString() }, [p]),
        );
  const check = { results };
  for (const r of check.results) {
    out.set(r.id, {
      conflicts: r.conflicts.map((c) => ({
        title: c.title,
        start: c.start,
        end: c.end,
        kind: c.kind === "event" ? (base.events.find((e) => e.title === c.title)?.kind ?? "fixed") : "flexible",
      })),
      warnings: r.warnings.map((w) => w.text),
    });
  }
  return out;
}

export async function approveItems(
  userId: string,
  planId: string,
  input: {
    itemIds?: string[] | null;
    edits?: Record<string, { start: string; end: string }> | null;
    emailEdits?: Record<string, { to: string; subject: string; body: string }> | null;
    requestId: string;
    now?: Date;
  },
): Promise<{ plan: StoredPlan; results: ItemResult[] }> {
  const now = input.now ?? new Date();
  let plan = await getPlan(userId, planId);
  const wanted = input.itemIds ? new Set(input.itemIds) : null;
  const results: ItemResult[] = [];

  // Already-applied or rejected items in the selection are reported, not redone.
  const selected = plan.items.filter((i) => (wanted ? wanted.has(i.id) : OPEN.has(i.status) && i.status !== "failed"));
  const open: StoredItem[] = [];
  for (const item of selected) {
    if (OPEN.has(item.status)) open.push(item);
    else results.push({ itemId: item.id, outcome: item.status === "applied" ? "already_applied" : "stale", message: `Already ${item.status}.` });
  }

  // Time edits first, so the re-check sees the edited times.
  const timeZone = String(open.find((i) => typeof i.payload.timezone === "string")?.payload.timezone ?? "UTC");
  for (const item of open) {
    const edit = input.edits?.[item.id];
    if (!edit) continue;
    const changed = editTimes(item, edit, timeZone);
    item.payload = changed.payload;
    item.display = changed.display;
    await updateOpenItem(userId, item, { payload: changed.payload, display: changed.display });
  }

  const checks = await recheck(userId, open, now);
  const ops: Op[] = [];
  let preferencesBefore: SchedulingPreferences | null = null;

  for (const item of open) {
    const check = checks.get(item.id);
    if (check) {
      const blocking = BLOCKING.has(item.action) && check.conflicts.length > 0;
      const display: ItemDisplay = { ...item.display, conflicts: check.conflicts, warnings: check.warnings };
      if (blocking) {
        const message = `Now overlaps ${check.conflicts.map((c) => c.title).join(", ")}.`;
        await updateOpenItem(userId, item, { display, status: "conflict", error: message });
        results.push({ itemId: item.id, outcome: "conflict", message });
        continue;
      }
      await updateOpenItem(userId, item, { display });
    }

    if (item.action === "send_email") {
      const edited = input.emailEdits?.[item.id];
      const payload = edited ? { ...item.payload, to: edited.to, subject: edited.subject, body: edited.body } : item.payload;
      const parsed = parsePayload("send_email", payload);
      if (!parsed.ok) {
        await updateOpenItem(userId, item, { error: parsed.error });
        results.push({ itemId: item.id, outcome: "failed", message: parsed.error });
        continue;
      }
      try {
        await sendApprovedEmail(userId, parsed.value);
      } catch (e) {
        const message = e instanceof DataValidationError ? e.message : "The email wasn't sent. Try again in a moment.";
        if (!(e instanceof DataValidationError)) console.error("[plan] gmail send failed", e);
        await updateOpenItem(userId, item, { payload: parsed.value, error: message });
        results.push({ itemId: item.id, outcome: "failed", message });
        continue;
      }
      if (edited) {
        item.payload = parsed.value;
        item.display = { ...item.display, detail: `To ${parsed.value.to}` };
        item.title = parsed.value.subject;
        await updateOpenItem(userId, item, { payload: parsed.value, display: item.display, title: parsed.value.subject });
      }
      ops.push({ item_id: item.id, op: "mark_applied", result_id: null, undo: { op: "none" } });
      continue;
    }

    if (item.action === "update_preferences") {
      const change = parsePayload("update_preferences", item.payload);
      if (!change.ok) {
        await updateOpenItem(userId, item, { error: change.error });
        results.push({ itemId: item.id, outcome: "failed", message: change.error });
        continue;
      }
      preferencesBefore ??= await getSchedulingPreferences(userId);
      await saveSchedulingPreferences(userId, applyPreferenceChanges(preferencesBefore, change.value));
      ops.push({ item_id: item.id, op: "mark_applied", result_id: null, undo: { op: "none", previous: preferencesBefore } });
      continue;
    }

    // Google Calendar events change in Google first; the item is then recorded as applied
    // with an undo that restores Google.
    const google = googleTarget(item);
    if (google) {
      try {
        const undo = await applyGoogle(userId, item, google, now);
        ops.push({ item_id: item.id, op: "mark_applied", result_id: null, undo: { op: "none", google: undo } } as Op);
      } catch (e) {
        const message = e instanceof DataValidationError ? e.message : "Google Calendar didn't accept the change. Try again in a moment.";
        if (!(e instanceof DataValidationError)) console.error("[plan] google write failed", e);
        await updateOpenItem(userId, item, { error: message });
        results.push({ itemId: item.id, outcome: "failed", message });
      }
      continue;
    }

    const built = toOp(item);
    if (!built.ok) {
      await updateOpenItem(userId, item, { error: built.error });
      results.push({ itemId: item.id, outcome: "failed", message: built.error });
      continue;
    }
    ops.push(built.op);
  }

  const applied = await applyPlanItems(userId, planId, input.requestId, ops);
  for (const r of applied) {
    const outcome = (["applied", "already_applied", "conflict", "stale", "failed"] as const).find((o) => o === r.outcome) ?? "failed";
    results.push({ itemId: r.item_id, outcome, message: r.message ? friendlyDbMessage(r.message) : undefined });
  }
  plan = await getPlan(userId, planId);
  // Plan vs reality: a task marked done means its past sessions happened.
  const appliedIds = new Set(results.filter((r) => r.outcome === "applied").map((r) => r.itemId));
  for (const item of plan.items) {
    if (item.action === "complete_task" && appliedIds.has(item.id) && item.targetId) {
      await markPastSessionsDone(userId, item.targetId, now).catch((e) => console.error("[plan] session outcomes not recorded", e));
    }
  }
  await linkNewTaskSessions(userId, plan).catch((e) => console.error("[plan] sessions not linked to their new task", e));
  return { plan, results };
}

/** Items that change a Google Calendar event carry `google: { scope }` in their payload. */
function googleTarget(item: StoredItem): { commitmentId: string; scope: GoogleScope } | null {
  if (item.action !== "remove_event" && item.action !== "update_event") return null;
  const g = item.payload.google as { scope?: unknown } | undefined;
  const id = item.payload.commitmentId;
  if (!g || typeof id !== "string") return null;
  return { commitmentId: id, scope: g.scope === "series" ? "series" : "one" };
}

async function applyGoogle(userId: string, item: StoredItem, g: { commitmentId: string; scope: GoogleScope }, now: Date): Promise<GoogleUndo> {
  if (item.action === "remove_event") return removeGoogleEvent(userId, g.commitmentId, g.scope, now);
  const patch = (item.payload.patch ?? {}) as { title?: string; starts_at?: string; ends_at?: string; location?: string | null; recurrence_rule?: unknown };
  if (patch.recurrence_rule !== undefined) throw new DataValidationError(`To change how ${item.title} repeats, change it in Google Calendar.`);
  const expect = (item.payload.expect ?? undefined) as { title?: string | null; starts_at?: string | null; ends_at?: string | null } | undefined;
  return updateGoogleEvent(
    userId,
    g.commitmentId,
    { title: patch.title, startsAt: patch.starts_at, endsAt: patch.ends_at, location: patch.location },
    g.scope,
    { now, expect },
  );
}

/**
 * Sessions proposed on the same card as a new task (the reality check in
 * buildPlan) carry no task id, because the task didn't exist yet. Once both
 * are applied, in either order, the sessions are linked to it.
 */
async function linkNewTaskSessions(userId: string, plan: StoredPlan): Promise<void> {
  const tasks = plan.items.filter((i) => i.action === "create_task" && i.status === "applied" && i.resultId);
  if (!tasks.length) return;
  for (const task of tasks) {
    const sessions = plan.items.filter(
      (i) =>
        i.action === "schedule_block" &&
        i.status === "applied" &&
        i.resultId &&
        i.payload.forNewTask === true &&
        !i.payload.taskId &&
        normalizeText(String(i.payload.title ?? "")) === normalizeText(task.title),
    );
    if (sessions.length) await linkSessionsToTask(userId, sessions.map((i) => i.resultId!), task.resultId!);
  }
}

function friendlyDbMessage(message: string): string {
  if (/violates check constraint|invalid input/i.test(message)) return "Some details weren't valid, so this wasn't saved.";
  if (/not found/i.test(message)) return "The item it changes no longer exists.";
  return message.length > 160 ? "This change couldn't be saved." : message;
}

export async function rejectItemsInPlan(userId: string, planId: string, itemIds: string[] | null) {
  const { rejectItems } = await import("@/lib/db/plans");
  const rejected = await rejectItems(userId, planId, itemIds);
  const plan = await getPlan(userId, planId);
  return { plan, results: rejected.map((id) => ({ itemId: id, outcome: "rejected" as const })) };
}

export async function editItem(
  userId: string,
  planId: string,
  input: { itemId: string; start: string; end: string; title?: string },
  now = new Date(),
): Promise<{ plan: StoredPlan; results: ItemResult[] }> {
  const plan = await getPlan(userId, planId);
  const item = plan.items.find((i) => i.id === input.itemId);
  if (!item || !OPEN.has(item.status)) throw new DataValidationError("This suggestion can't be changed anymore.");
  const timeZone = String(item.payload.timezone ?? "UTC");
  const changed = editTimes(item, { start: input.start, end: input.end }, timeZone);
  const title = input.title?.replace(/\s+/g, " ").trim();
  if (title && title.length <= 200 && (item.action === "schedule_block" || item.action === "create_event")) changed.payload.title = title;
  const checks = await recheck(userId, [{ ...item, payload: changed.payload }], now);
  const check = checks.get(item.id);
  const display = { ...changed.display, conflicts: check?.conflicts ?? [], warnings: check?.warnings ?? [] };
  const blocking = BLOCKING.has(item.action) && display.conflicts.length > 0;
  await updateOpenItem(userId, item, {
    payload: changed.payload,
    display,
    status: blocking ? "conflict" : "pending",
    error: blocking ? `Overlaps ${display.conflicts.map((c) => c.title).join(", ")}.` : null,
  });
  return {
    plan: await getPlan(userId, planId),
    results: blocking ? [{ itemId: item.id, outcome: "conflict", message: "That time overlaps something." }] : [],
  };
}

/** Asks the engine for a different time for each item, avoiding times already offered. */
export async function findAlternatives(
  userId: string,
  planId: string,
  itemIds: string[],
  now = new Date(),
): Promise<{ plan: StoredPlan; results: ItemResult[] }> {
  const plan = await getPlan(userId, planId);
  const items = plan.items.filter((i) => itemIds.includes(i.id) && OPEN.has(i.status) && BLOCKING.has(i.action));
  if (!items.length) throw new DataValidationError("Only suggested sessions can get another time.");
  const timeZone = String(items[0].payload.timezone ?? "UTC");
  const todayKey = dateKeyInZone(now, timeZone);
  const window = { start: now.toISOString(), end: new Date(now.getTime() + 62 * 86_400_000).toISOString() };
  const base = await loadSchedulingBase(userId, window);
  const otherPlans = await listPendingBlocks(userId, { excludePlanId: planId, now });
  const results: ItemResult[] = [];

  for (const item of items) {
    const start = String(item.payload.startsAt);
    const end = String(item.payload.endsAt);
    const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
    const original = plan.context.requests.find((r) => r.id === item.payload.requestId);
    const avoided = [...((item.payload.avoid as { start: string; end: string }[] | undefined) ?? []), { start, end }].slice(-10);
    const siblings = plan.items
      .filter((i) => i.id !== item.id && OPEN.has(i.status) && BLOCKING.has(i.action) && typeof i.payload.startsAt === "string")
      .map((i) => ({ start: String(i.payload.startsAt), end: String(i.payload.endsAt), title: i.title }));
    const deadline =
      original?.deadline ?? startOfDayInZone(addDaysToKey(todayKey, 8), timeZone).toISOString();
    const request: PlanRequest = {
      id: "alt",
      title: String(item.payload.title ?? item.title),
      amount: { type: "single", minutes },
      priority: original?.priority ?? "medium",
      deadline,
      earliestStart: original?.earliestStart ?? null,
      avoid: avoided,
      lifeAreaId: (item.payload.lifeAreaId as string | null) ?? null,
      taskId: (item.payload.taskId as string | null) ?? null,
    };
    const moving = item.action === "move_block" ? String(item.payload.commitmentId) : null;
    const result = planSchedule({
      now: now.toISOString(),
      timeZone: base.timeZone,
      window: { start: window.start, end: Date.parse(deadline) < Date.parse(window.end) ? deadline : window.end },
      events: base.events.filter((e) => e.id !== moving),
      busy: [...otherPlans, ...siblings, ...avoided.map((a) => ({ ...a, title: "Not this time" }))],
      preferences: base.preferences,
      requests: [request],
    });
    const session = result.sessions[0];
    if (!session) {
      const message = result.outcomes[0]?.issue?.message ?? "No other time fits before it's due.";
      results.push({ itemId: item.id, outcome: "failed", message });
      continue;
    }
    const payload = { ...item.payload, startsAt: session.start, endsAt: session.end, avoid: avoided };
    const display: ItemDisplay = {
      ...item.display,
      timing: timingFor(session.start, session.end, timeZone),
      reason: `Another option. ${session.reasons.map((r) => r.text).join(" ")}`.trim(),
      tradeoffs: session.tradeoffs.map((t) => t.text),
      alternatives: session.alternatives,
      conflicts: [],
      warnings: [],
    };
    await updateOpenItem(userId, item, { payload, display, status: "pending", error: null });
  }
  return { plan: await getPlan(userId, planId), results };
}

export async function undoItem(userId: string, planId: string, itemId: string, now = new Date()): Promise<{ plan: StoredPlan; results: ItemResult[] }> {
  const plan = await getPlan(userId, planId);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item || item.status !== "applied" || !item.undo) throw new DataValidationError("There's nothing to undo.");
  if (item.action === "update_preferences") {
    const previous = (item.undo as { previous?: unknown }).previous;
    if (previous) await saveSchedulingPreferences(userId, previous);
  }
  const google = (item.undo as { google?: GoogleUndo }).google;
  if (google) await undoGoogleChange(userId, google, now);
  await undoPlanItem(item.id);
  return { plan: await getPlan(userId, planId), results: [] };
}
