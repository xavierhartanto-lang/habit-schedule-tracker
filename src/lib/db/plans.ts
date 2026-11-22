import "server-only";

import type {
  PlanConflict,
  PlanItem,
  PlanItemAction,
  PlanItemStatus,
  PlanKind,
  PlanTiming,
  PlanView,
} from "@/features/assistant/plan-types";
import { CALENDAR_ACTIONS, PLAN_ITEM_ACTIONS } from "@/features/assistant/plan-types";
import type { BuiltPlan, ItemDisplay } from "@/lib/assistant/build-plan";
import { readActions, writeActions, type ActionContext, type ItemState } from "@/lib/assistant/action-state";
import { isUuid } from "@/lib/domain/context-items";
import { NotFoundError, dbError, requireDb } from "./client";
import type { Json, PlanItemRow, PlanProposalRow } from "./database.types";

/**
 * Plans (AI proposals) and their items. Every query runs as the signed-in
 * user, so RLS keeps plans private. Applying items goes through the
 * apply_plan_items database function (one transaction, per-user lock,
 * idempotency key); nothing here writes calendar or task rows directly.
 */

/** A plan older than this is shown as stale; approving still re-checks every item. */
export const PLAN_STALE_MS = 24 * 60 * 60 * 1000;

export type StoredItem = {
  id: string;
  proposalId: string;
  position: number;
  action: PlanItemAction;
  status: PlanItemStatus;
  autoApplied: boolean;
  title: string;
  payload: Record<string, unknown>;
  display: ItemDisplay;
  targetId: string | null;
  resultId: string | null;
  undo: Record<string, unknown> | null;
  error: string | null;
};

export type StoredPlan = {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  sourceMessageId: string | null;
  kind: PlanKind;
  status: PlanView["status"];
  summary: string | null;
  unscheduled: PlanView["unscheduled"];
  context: BuiltPlan["context"];
  version: number;
  createdAt: string;
  expiresAt: string;
  items: StoredItem[];
};

function obj(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toDisplay(value: Json): ItemDisplay {
  const d = obj(value);
  const timing = obj(d.timing as Json);
  const previous = obj(d.previous as Json);
  return {
    detail: typeof d.detail === "string" ? d.detail : null,
    timing: typeof timing.start === "string" ? (timing as unknown as PlanTiming) : null,
    previous: typeof previous.start === "string" ? (previous as { start: string; end: string }) : null,
    reason: typeof d.reason === "string" ? d.reason : null,
    tradeoffs: strings(d.tradeoffs),
    conflicts: Array.isArray(d.conflicts) ? (d.conflicts as PlanConflict[]) : [],
    warnings: strings(d.warnings),
    alternatives: Array.isArray(d.alternatives) ? (d.alternatives as { start: string; end: string }[]) : [],
    editable: d.editable === true,
    chips: Array.isArray(d.chips) ? (d.chips as ItemDisplay["chips"]) : [],
    nearby: Array.isArray(d.nearby) ? (d.nearby as ItemDisplay["nearby"]) : [],
    deadline: typeof d.deadline === "string" ? d.deadline : null,
    step: d.step && typeof d.step === "object" && !Array.isArray(d.step) ? (d.step as ItemDisplay["step"]) : null,
  };
}

function toItem(row: PlanItemRow): StoredItem {
  const action = (PLAN_ITEM_ACTIONS as readonly string[]).includes(row.action) ? (row.action as PlanItemAction) : "save_fact";
  return {
    id: row.id,
    proposalId: row.proposal_id,
    position: row.position,
    action,
    status: row.status,
    autoApplied: row.auto_applied,
    title: row.title,
    payload: obj(row.payload),
    display: toDisplay(row.display),
    targetId: row.target_id,
    resultId: row.result_id,
    undo: row.undo ? obj(row.undo) : null,
    error: row.error,
  };
}

function toPlan(row: PlanProposalRow, items: PlanItemRow[]): StoredPlan {
  const context = obj(row.context);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    unscheduled: Array.isArray(row.unscheduled) ? (row.unscheduled as PlanView["unscheduled"]) : [],
    context: {
      requests: Array.isArray(context.requests) ? (context.requests as BuiltPlan["context"]["requests"]) : [],
      window: (context.window as BuiltPlan["context"]["window"]) ?? null,
    },
    version: row.version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    items: items
      .filter((i) => i.proposal_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map(toItem),
  };
}

const UNDOABLE: ReadonlySet<PlanItemAction> = new Set([
  "schedule_block",
  "move_block",
  "create_event",
  "create_task",
  "update_task",
  "complete_task",
  "remove_task",
  "remove_event",
  "skip_occurrence",
  "remove_block",
  "update_event",
  "create_habit",
  "update_habit",
  "create_goal",
  "update_goal",
  "set_life_area",
  "update_preferences",
  "save_fact",
]);

/** What the client sees. Stale = past its expiry while items are still open. */
export function toPlanView(plan: StoredPlan, now = new Date()): PlanView {
  const open = plan.items.some((i) => i.status === "pending" || i.status === "conflict");
  const stale = open && Date.parse(plan.expiresAt) < now.getTime();
  return {
    id: plan.id,
    conversationId: plan.conversationId,
    messageId: plan.messageId,
    kind: plan.kind,
    status: stale && plan.status === "pending" ? "stale" : plan.status,
    summary: plan.summary,
    version: plan.version,
    createdAt: plan.createdAt,
    unscheduled: plan.unscheduled,
    items: plan.items.map(
      (i): PlanItem => ({
        id: i.id,
        position: i.position,
        action: i.action,
        group: CALENDAR_ACTIONS.has(i.action) ? "calendar" : "organize",
        status: i.status,
        autoApplied: i.autoApplied,
        title: i.title,
        detail: i.display.detail,
        lifeAreaId: typeof i.payload.lifeAreaId === "string" ? i.payload.lifeAreaId : null,
        timing: i.display.timing,
        previous: i.display.previous,
        reason: i.display.reason,
        tradeoffs: i.display.tradeoffs,
        conflicts: i.display.conflicts,
        warnings: i.display.warnings,
        chips: i.display.chips ?? [],
        nearby: i.display.nearby ?? [],
        deadline: i.display.deadline ?? null,
        step: i.display.step ?? null,
        editable: i.display.editable && (i.status === "pending" || i.status === "conflict"),
        canUndo: i.status === "applied" && UNDOABLE.has(i.action) && i.undo !== null,
        targetId: i.targetId,
        resultId: i.resultId,
        error: i.error,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPlan(userId: string, planId: string): Promise<StoredPlan> {
  if (!isUuid(planId)) throw new NotFoundError("Plan");
  const supabase = await requireDb();
  const [{ data: plan, error }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from("plan_proposals").select("*").eq("user_id", userId).eq("id", planId).maybeSingle(),
    supabase.from("plan_items").select("*").eq("user_id", userId).eq("proposal_id", planId).order("position"),
  ]);
  if (error) throw dbError(error);
  if (itemsError) throw dbError(itemsError);
  if (!plan) throw new NotFoundError("Plan");
  return toPlan(plan, items);
}

/** Plans in a conversation, keyed by the assistant message that presented them. */
export async function listPlansForConversation(userId: string, conversationId: string): Promise<Map<string, StoredPlan>> {
  const supabase = await requireDb();
  const { data: plans, error } = await supabase
    .from("plan_proposals")
    .select("*")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at")
    .limit(200);
  if (error) throw dbError(error);
  const out = new Map<string, StoredPlan>();
  if (!plans.length) return out;
  const { data: items, error: itemsError } = await supabase
    .from("plan_items")
    .select("*")
    .eq("user_id", userId)
    .in("proposal_id", plans.map((p) => p.id))
    .limit(5000);
  if (itemsError) throw dbError(itemsError);
  for (const p of plans) if (p.message_id) out.set(p.message_id, toPlan(p, items));
  return out;
}

/**
 * Calendar blocks proposed in the user's open plans (not yet applied), so a
 * new plan never double-books time another plan is still offering.
 */
export async function listPendingBlocks(
  userId: string,
  options: { excludePlanId?: string; now?: Date } = {},
): Promise<{ start: string; end: string; title: string; taskId: string | null }[]> {
  const supabase = await requireDb();
  const now = options.now ?? new Date();
  const { data: plans, error } = await supabase
    .from("plan_proposals")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["pending", "partially_applied"])
    .gt("expires_at", now.toISOString())
    .limit(50);
  if (error) throw dbError(error);
  const ids = plans.map((p) => p.id).filter((id) => id !== options.excludePlanId);
  if (!ids.length) return [];
  const { data: items, error: itemsError } = await supabase
    .from("plan_items")
    .select("title, display, payload, action, status")
    .eq("user_id", userId)
    .in("proposal_id", ids)
    .in("action", ["schedule_block", "move_block"])
    .in("status", ["pending", "conflict"])
    .limit(500);
  if (itemsError) throw dbError(itemsError);
  return items.flatMap((i) => {
    const t = toDisplay(i.display).timing;
    const taskId = obj(i.payload).taskId;
    return t ? [{ start: t.start, end: t.end, title: i.title, taskId: typeof taskId === "string" ? taskId : null }] : [];
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createPlan(
  userId: string,
  input: { conversationId: string | null; sourceMessageId: string | null; built: BuiltPlan; now?: Date },
): Promise<StoredPlan> {
  const supabase = await requireDb();
  const now = input.now ?? new Date();
  const { data: plan, error } = await supabase
    .from("plan_proposals")
    .insert({
      user_id: userId,
      conversation_id: input.conversationId,
      source_message_id: input.sourceMessageId,
      kind: input.built.kind,
      summary: input.built.summary?.slice(0, 1000) ?? null,
      unscheduled: input.built.unscheduled.slice(0, 20) as unknown as Json,
      context: input.built.context as unknown as Json,
      expires_at: new Date(now.getTime() + PLAN_STALE_MS).toISOString(),
    })
    .select("*")
    .single();
  if (error) throw dbError(error);

  const rows = input.built.items.slice(0, 200).map((item, position) => ({
    user_id: userId,
    proposal_id: plan.id,
    position,
    action: item.action,
    title: item.title.slice(0, 300),
    payload: item.payload as unknown as Json,
    display: item.display as unknown as Json,
    target_id: item.targetId,
  }));
  if (!rows.length) return toPlan(plan, []);
  const { data: items, error: itemsError } = await supabase.from("plan_items").insert(rows).select("*");
  if (itemsError) {
    // Don't leave an empty plan behind.
    await supabase.from("plan_proposals").delete().eq("user_id", userId).eq("id", plan.id);
    throw dbError(itemsError);
  }
  return toPlan(plan, items);
}

export async function setPlanMessage(userId: string, planId: string, messageId: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase
    .from("plan_proposals")
    .update({ message_id: messageId })
    .eq("user_id", userId)
    .eq("id", planId);
  if (error) throw dbError(error);
}

/** Marks items auto-applied (call after apply_plan_items applied them). */
export async function markAutoApplied(userId: string, itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  const supabase = await requireDb();
  const { error } = await supabase
    .from("plan_items")
    .update({ auto_applied: true })
    .eq("user_id", userId)
    .in("id", itemIds);
  if (error) throw dbError(error);
}

/**
 * Updates one pending item (edit, new alternative, conflict state) only if
 * it is still open, and bumps the plan version.
 */
export async function updateOpenItem(
  userId: string,
  item: { id: string; proposalId: string },
  patch: { payload?: Record<string, unknown>; display?: ItemDisplay; status?: "pending" | "conflict"; error?: string | null },
): Promise<boolean> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("plan_items")
    .update({
      ...(patch.payload ? { payload: patch.payload as unknown as Json } : {}),
      ...(patch.display ? { display: patch.display as unknown as Json } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    })
    .eq("user_id", userId)
    .eq("id", item.id)
    .in("status", ["pending", "conflict", "failed"])
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error);
  if (data) await bumpVersion(userId, item.proposalId);
  return !!data;
}

/** Rejects open items. Applied items are never touched. */
export async function rejectItems(userId: string, planId: string, itemIds: string[] | null): Promise<string[]> {
  const supabase = await requireDb();
  let query = supabase
    .from("plan_items")
    .update({ status: "rejected" })
    .eq("user_id", userId)
    .eq("proposal_id", planId)
    .in("status", ["pending", "conflict", "failed"]);
  if (itemIds) query = query.in("id", itemIds.filter(isUuid));
  const { data, error } = await query.select("id");
  if (error) throw dbError(error);
  await refreshStatus(userId, planId);
  return data.map((d) => d.id);
}

/** Older open suggestions this plan replaces ("actually it's at 7"). */
export async function supersedeItems(userId: string, itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("plan_items")
    .update({ status: "rejected", error: "Replaced by a newer suggestion." })
    .eq("user_id", userId)
    .in("id", itemIds)
    .eq("status", "pending")
    .select("proposal_id");
  if (error) throw dbError(error);
  for (const id of new Set(data.map((d) => d.proposal_id))) await refreshStatus(userId, id);
}

/** Open items in a conversation's earlier plans, for spotting corrections. */
export async function listOpenItemsInConversation(userId: string, conversationId: string): Promise<StoredItem[]> {
  const supabase = await requireDb();
  const { data: plans, error } = await supabase
    .from("plan_proposals")
    .select("id")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .in("status", ["pending", "partially_applied"])
    .limit(50);
  if (error) throw dbError(error);
  if (!plans.length) return [];
  const { data: items, error: itemsError } = await supabase
    .from("plan_items")
    .select("*")
    .eq("user_id", userId)
    .in("proposal_id", plans.map((p) => p.id))
    .eq("status", "pending")
    .limit(500);
  if (itemsError) throw dbError(itemsError);
  return items.map(toItem);
}

async function bumpVersion(userId: string, planId: string): Promise<void> {
  const supabase = await requireDb();
  const { data, error } = await supabase.from("plan_proposals").select("version").eq("user_id", userId).eq("id", planId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) return;
  const { error: updateError } = await supabase
    .from("plan_proposals")
    .update({ version: data.version + 1 })
    .eq("user_id", userId)
    .eq("id", planId);
  if (updateError) throw dbError(updateError);
}

/** Recomputes a plan's status from its items and bumps its version. */
export async function refreshStatus(userId: string, planId: string): Promise<void> {
  const supabase = await requireDb();
  const { data: items, error } = await supabase.from("plan_items").select("status").eq("user_id", userId).eq("proposal_id", planId);
  if (error) throw dbError(error);
  const statuses = items.map((i) => i.status);
  const open = statuses.filter((s) => s === "pending" || s === "conflict" || s === "failed").length;
  const applied = statuses.filter((s) => s === "applied").length;
  const status = !statuses.length
    ? "pending"
    : open === 0 && applied > 0
      ? "applied"
      : applied > 0
        ? "partially_applied"
        : open === 0
          ? "rejected"
          : "pending";
  const { data: plan, error: readError } = await supabase.from("plan_proposals").select("version").eq("user_id", userId).eq("id", planId).maybeSingle();
  if (readError) throw dbError(readError);
  if (!plan) return;
  const { error: updateError } = await supabase
    .from("plan_proposals")
    .update({ status, version: plan.version + 1 })
    .eq("user_id", userId)
    .eq("id", planId);
  if (updateError) throw dbError(updateError);
}

export type ApplyResult = { item_id: string; outcome: string; message?: string; result_id?: string | null };

/** One transaction: applies the ops, records the request id. Safe to retry. */
export async function applyPlanItems(userId: string, planId: string, requestId: string, ops: unknown[]): Promise<ApplyResult[]> {
  void userId; // RLS + auth.uid() inside the function scope it to the signed-in user.
  const supabase = await requireDb();
  const { data, error } = await supabase.rpc("apply_plan_items", {
    p_proposal_id: planId,
    p_request_id: requestId,
    p_ops: ops as unknown as Json,
  });
  if (error) {
    if (error.code === "P0002") throw new NotFoundError("Plan");
    throw dbError(error);
  }
  return Array.isArray(data) ? (data as unknown as ApplyResult[]) : [];
}

export async function undoPlanItem(itemId: string): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase.rpc("undo_plan_item", { p_item_id: itemId });
  if (error) {
    if (error.code === "P0002") throw new NotFoundError("Item");
    throw dbError(error);
  }
}

// ---------------------------------------------------------------------------
// Conversation action state (see lib/assistant/action-state.ts)
// ---------------------------------------------------------------------------

export async function getActions(userId: string, conversationId: string): Promise<ActionContext[]> {
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("conversations")
    .select("planning_state")
    .eq("user_id", userId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw dbError(error);
  return readActions(data?.planning_state ?? null);
}

export async function setActions(userId: string, conversationId: string, actions: ActionContext[]): Promise<void> {
  const supabase = await requireDb();
  const { error } = await supabase
    .from("conversations")
    .update({ planning_state: writeActions(actions) as unknown as Json })
    .eq("user_id", userId)
    .eq("id", conversationId);
  if (error) throw dbError(error);
}

/** Real status of plan items, so action state follows the database. */
export async function getItemStates(userId: string, itemIds: string[]): Promise<ItemState[]> {
  const ids = [...new Set(itemIds.filter(isUuid))];
  if (!ids.length) return [];
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("plan_items")
    .select("id, status, error, result_id, target_id")
    .eq("user_id", userId)
    .in("id", ids.slice(0, 200));
  if (error) throw dbError(error);
  return data.map((r) => ({ id: r.id, status: r.status, error: r.error, resultId: r.result_id, targetId: r.target_id }));
}
