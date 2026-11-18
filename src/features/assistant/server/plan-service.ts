import "server-only";

import { randomUUID } from "node:crypto";

import type { ChatTurn } from "@/lib/ai/prompts";
import { interpretMessage } from "@/lib/ai/service";
import { normalizeText } from "@/lib/ai/extraction";
import { assessIntent, type RefTable, type World } from "@/lib/assistant/assess";
import { buildPlan, timingFor, type ItemDisplay } from "@/lib/assistant/build-plan";
import { DRAFT_TTL_MS, nextDrafts } from "@/lib/assistant/drafts";
import { dedupeIntents } from "@/lib/assistant/intents";
import { parsePayload, toOp, type Op } from "@/lib/assistant/ops";
import { buildPlannerUserPrompt, plannerResultBlock } from "@/lib/assistant/planner-prompt";
import { applyPreferenceChanges } from "@/lib/assistant/prefs";
import { DataValidationError } from "@/lib/db/client";
import { listGoals } from "@/lib/db/goals";
import { listActiveHabits } from "@/lib/db/habits";
import { listLifeAreas } from "@/lib/db/life-areas";
import {
  applyPlanItems,
  createPlan,
  getDrafts,
  getPlan,
  listOpenItemsInConversation,
  listPendingBlocks,
  markAutoApplied,
  setDrafts,
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
import { addDaysToKey, dateKeyInZone, startOfDayInZone } from "@/lib/scheduling/zoned";
import type { Clarify, PlanItemOutcome, PlanView } from "../plan-types";

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
  const windowStart = new Date(now.getTime() - 86_400_000).toISOString();
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
    world: { todayKey, timeZone, weekStartsOn, areas, refs },
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
};

export async function planTurn(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  userText: string;
  history: ChatTurn[];
  signal?: AbortSignal;
  now?: Date;
}): Promise<PlanTurnResult> {
  const now = input.now ?? new Date();
  const [previousDrafts, loaded] = await Promise.all([getDrafts(input.userId, input.conversationId), loadWorld(input.userId, now)]);
  const drafts = previousDrafts.filter((d) => now.getTime() - Date.parse(d.createdAt) < DRAFT_TTL_MS);
  const { world } = loaded;

  const interpreted = await interpretMessage({
    userMessage: input.userText,
    drafts,
    signal: input.signal,
    prompt: buildPlannerUserPrompt({
      todayKey: world.todayKey,
      weekday: weekdayName(world.todayKey),
      timeZone: world.timeZone,
      areas: world.areas,
      refs: world.refs,
      drafts,
      recentHistory: input.history.slice(-6),
      newUserText: input.userText,
    }),
  });
  if (interpreted.dropped.length) console.info("[plan] dropped intents", interpreted.dropped);

  const assessments = dedupeIntents(interpreted.intents).map((i) => assessIntent(i, world));
  const next = nextDrafts(drafts, interpreted.consumedDrafts, assessments, now);
  const notes = next.givenUp.map((about) => `Stopped asking about ${about}; the user can add it from the calendar.`);
  const clarify: Clarify | null =
    next.clarify ?? (interpreted.question ? { about: "Your message", field: "other", question: interpreted.question, choices: [] } : null);

  const ready = assessments.flatMap((a) => (a.status === "ready" ? [{ spec: a.spec, explicit: a.intent.explicit }] : []));
  let plan: StoredPlan | null = null;

  if (ready.length) {
    const busy = await listPendingBlocks(input.userId, { now });
    const built = buildPlan({
      now: now.toISOString(),
      world,
      preferences: loaded.preferences,
      events: loaded.events,
      openTasks: loaded.openTasks,
      busy,
      specs: ready,
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
      await supersedeOlder(input.userId, input.conversationId, plan);
      const auto = plan.items.filter((i, idx) => built.items[idx]?.autoApply).map((i) => i.id);
      if (auto.length) {
        const { results } = await approveItems(input.userId, plan.id, { itemIds: auto, requestId: randomUUID(), now });
        await markAutoApplied(
          input.userId,
          results.filter((r) => r.outcome === "applied").map((r) => r.itemId),
        );
      }
      plan = await getPlan(input.userId, plan.id);
    }
  }

  await setDrafts(input.userId, input.conversationId, next.drafts);
  const view = plan ? toPlanView(plan, now) : null;
  return {
    plan: view,
    clarify,
    actions: plannerResultBlock({ plan: view, question: clarify?.question ?? null, notes, failed: null }),
  };
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

const TIMED: ReadonlySet<string> = new Set(["create_event", "schedule_block", "move_block"]);
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
  const moving = new Set(timed.filter((i) => i.action === "move_block").map((i) => String(i.payload.commitmentId)));
  const check = checkPlacements(
    {
      now: now.toISOString(),
      timeZone: base.timeZone,
      window,
      events: base.events.filter((e) => !moving.has(e.id)),
      preferences: base.preferences,
    },
    timed.map((i) => ({ id: i.id, start: String(i.payload.startsAt), end: String(i.payload.endsAt), title: i.title })),
  );
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
  input: { itemIds?: string[] | null; edits?: Record<string, { start: string; end: string }> | null; requestId: string; now?: Date },
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
  return { plan, results };
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

export async function undoItem(userId: string, planId: string, itemId: string): Promise<{ plan: StoredPlan; results: ItemResult[] }> {
  const plan = await getPlan(userId, planId);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item || item.status !== "applied" || !item.undo) throw new DataValidationError("There's nothing to undo.");
  if (item.action === "update_preferences") {
    const previous = (item.undo as { previous?: unknown }).previous;
    if (previous) await saveSchedulingPreferences(userId, previous);
  }
  await undoPlanItem(item.id);
  return { plan: await getPlan(userId, planId), results: [] };
}
