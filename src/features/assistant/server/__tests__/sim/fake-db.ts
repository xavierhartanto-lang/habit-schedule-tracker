import type { ActionContext } from "@/lib/assistant/action-state";
import type { BuiltPlan } from "@/lib/assistant/build-plan";
import type { Commitment, Task } from "@/lib/domain/types";
import type { StoredItem, StoredPlan } from "@/lib/db/plans";

/**
 * In-memory stand-in for the database behind the assistant: commitments,
 * tasks, plans and their items, the conversation's action state, and the
 * `apply_plan_items` / `undo_plan_item` functions with the same undo
 * records the SQL writes. Like the real function, it does NOT protect
 * Google events: that is the app's job, and the simulation checks it.
 */

export type Db = {
  now: Date;
  events: Commitment[];
  tasks: Task[];
  plans: Map<string, StoredPlan>;
  planningState: unknown;
  approvals: Map<string, { item_id: string; outcome: string; message?: string; result_id?: string | null }[]>;
};

export const state: { db: Db; seq: number } = { db: blank(new Date()), seq: 0 };

function blank(now: Date): Db {
  return { now, events: [], tasks: [], plans: new Map(), planningState: null, approvals: new Map() };
}

export function resetDb(now: Date): void {
  state.db = blank(now);
}

export const newId = () => `20000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
const clone = <T>(v: T): T => structuredClone(v);

type Undo = { op: string; id?: string; row?: unknown; date?: string; starts_at?: string; ends_at?: string };

function applyOp(op: Record<string, unknown>, item: StoredItem): { resultId: string | null; undo: Undo | null } {
  const db = state.db;
  const row = (op.row ?? {}) as Record<string, unknown>;
  const patch = (op.patch ?? {}) as Record<string, unknown>;
  const event = (id: unknown) => db.events.find((e) => e.id === id);
  switch (op.op) {
    case "insert_commitment": {
      const ev: Commitment = {
        id: newId(),
        title: String(row.title),
        area: null,
        lifeAreaId: (row.life_area_id as string | null) ?? null,
        kind: row.kind === "flexible" ? "flexible" : "fixed",
        startsAt: String(row.starts_at),
        endsAt: String(row.ends_at),
        timezone: String(row.timezone),
        recurrenceRule: (row.recurrence_rule as string | null) ?? null,
        recurrenceExceptions: [],
        taskId: (row.task_id as string | null) ?? null,
        planItemId: item.id,
        source: "conversation",
      } as Commitment;
      db.events.push(ev);
      return { resultId: ev.id, undo: { op: "delete_commitment", id: ev.id } };
    }
    case "update_block_time": {
      const ev = event(op.id);
      if (!ev || ev.kind !== "flexible" || !ev.planItemId) throw new Error("Only sessions the assistant scheduled can be moved");
      const undo = { op: "restore_block_time", id: ev.id, starts_at: ev.startsAt!, ends_at: ev.endsAt! };
      ev.startsAt = String(op.starts_at);
      ev.endsAt = String(op.ends_at);
      return { resultId: ev.id, undo };
    }
    case "delete_block": {
      const ev = event(op.id);
      if (!ev || ev.kind !== "flexible" || !ev.planItemId) throw new Error("Only sessions the assistant scheduled can be removed");
      db.events = db.events.filter((e) => e.id !== ev.id);
      return { resultId: ev.id, undo: { op: "reinsert", row: clone(ev) } };
    }
    case "delete_event": {
      const ev = event(op.id);
      if (!ev) throw new Error("Event not found");
      db.events = db.events.filter((e) => e.id !== ev.id);
      return { resultId: ev.id, undo: { op: "reinsert", row: clone(ev) } };
    }
    case "skip_occurrence": {
      const ev = event(op.id);
      if (!ev || !ev.recurrenceRule) throw new Error("Repeating event not found");
      ev.recurrenceExceptions = [...new Set([...(ev.recurrenceExceptions ?? []), String(op.date)])].sort();
      return { resultId: ev.id, undo: { op: "unskip_occurrence", id: ev.id, date: String(op.date) } };
    }
    case "update_event": {
      const ev = event(op.id);
      if (!ev) throw new Error("Event not found");
      const expect = op.expect as Record<string, unknown> | undefined;
      if (expect && (expect.title !== ev.title || Date.parse(String(expect.starts_at)) !== Date.parse(ev.startsAt!))) {
        throw Object.assign(new Error("This event changed since the suggestion. Nothing was overwritten."), { stale: true });
      }
      const before = clone(ev);
      if ("title" in patch) ev.title = String(patch.title);
      if ("starts_at" in patch) ev.startsAt = String(patch.starts_at);
      if ("ends_at" in patch) ev.endsAt = String(patch.ends_at);
      if ("recurrence_rule" in patch) ev.recurrenceRule = (patch.recurrence_rule as string | null) || null;
      if ("location" in patch) ev.location = (patch.location as string | null) || null;
      return { resultId: ev.id, undo: { op: "restore_event", id: ev.id, row: before } };
    }
    case "insert_task": {
      const t: Task = {
        id: newId(),
        title: String(row.title),
        area: null,
        priority: (row.priority as Task["priority"]) ?? "medium",
        status: "todo",
        dueAt: (row.due_at as string | null) ?? null,
        estimatedMinutes: (row.estimated_minutes as number | null) ?? null,
      };
      db.tasks.push(t);
      return { resultId: t.id, undo: { op: "delete_task", id: t.id } };
    }
    case "update_task": {
      const t = db.tasks.find((x) => x.id === op.id);
      if (!t) throw new Error("Task not found");
      const before = clone(t);
      if (patch.status) t.status = patch.status as Task["status"];
      if (patch.title) t.title = String(patch.title);
      if (patch.priority) t.priority = patch.priority as Task["priority"];
      if ("due_at" in patch) t.dueAt = (patch.due_at as string | null) ?? null;
      if (patch.estimated_minutes) t.estimatedMinutes = Number(patch.estimated_minutes);
      return { resultId: t.id, undo: { op: "restore_task", id: t.id, row: before } };
    }
    case "remove_task": {
      const t = db.tasks.find((x) => x.id === op.id);
      if (!t) throw new Error("Task not found");
      db.tasks = db.tasks.filter((x) => x.id !== t.id);
      for (const e of db.events) if (e.taskId === t.id) e.taskId = null;
      return { resultId: t.id, undo: { op: "reinsert_task", row: clone(t) } };
    }
    case "insert_habit":
    case "update_habit":
    case "insert_goal":
    case "update_goal":
    case "set_life_area":
    case "insert_context_item":
      return { resultId: newId(), undo: { op: "none" } };
    default:
      throw new Error(`Unknown operation ${String(op.op)}`);
  }
}

function undoOp(undo: Undo): void {
  const db = state.db;
  switch (undo.op) {
    case "delete_commitment":
      db.events = db.events.filter((e) => e.id !== undo.id);
      return;
    case "restore_block_time": {
      const ev = db.events.find((e) => e.id === undo.id);
      if (ev) {
        ev.startsAt = undo.starts_at!;
        ev.endsAt = undo.ends_at!;
      }
      return;
    }
    case "reinsert":
      if (!db.events.some((e) => e.id === (undo.row as Commitment).id)) db.events.push(clone(undo.row as Commitment));
      return;
    case "unskip_occurrence": {
      const ev = db.events.find((e) => e.id === undo.id);
      if (ev) ev.recurrenceExceptions = (ev.recurrenceExceptions ?? []).filter((d) => d !== undo.date);
      return;
    }
    case "restore_event": {
      const i = db.events.findIndex((e) => e.id === undo.id);
      if (i >= 0) db.events[i] = clone(undo.row as Commitment);
      return;
    }
    case "delete_task":
      db.tasks = db.tasks.filter((t) => t.id !== undo.id);
      return;
    case "restore_task": {
      const i = db.tasks.findIndex((t) => t.id === undo.id);
      if (i >= 0) db.tasks[i] = clone(undo.row as Task);
      return;
    }
    case "reinsert_task":
      if (!db.tasks.some((t) => t.id === (undo.row as Task).id)) db.tasks.push(clone(undo.row as Task));
      return;
    default:
      return;
  }
}

export function allItems(): StoredItem[] {
  return [...state.db.plans.values()].flatMap((p) => p.items);
}

function planStatus(plan: StoredPlan): StoredPlan["status"] {
  const s = plan.items.map((i) => i.status);
  const open = s.filter((x) => x === "pending" || x === "conflict" || x === "failed").length;
  const applied = s.filter((x) => x === "applied").length;
  return open === 0 && applied > 0 ? "applied" : applied > 0 ? "partially_applied" : open === 0 && s.length ? "rejected" : "pending";
}

/** Replacement for "@/lib/db/plans". */
export async function plansModule(real: typeof import("@/lib/db/plans")) {
  const { readActions, writeActions } = await import("@/lib/assistant/action-state");
  const db = () => state.db;
  return {
    ...real,
    getPlan: async (_u: string, planId: string) => {
      const p = db().plans.get(planId);
      if (!p) throw new Error("Plan not found");
      return clone(p);
    },
    createPlan: async (_u: string, input: { conversationId: string | null; sourceMessageId: string | null; built: BuiltPlan; now?: Date }) => {
      const planId = newId();
      const plan: StoredPlan = {
        id: planId,
        conversationId: input.conversationId,
        messageId: null,
        sourceMessageId: input.sourceMessageId,
        kind: input.built.kind,
        status: "pending",
        summary: input.built.summary,
        unscheduled: input.built.unscheduled,
        context: input.built.context,
        version: 1,
        createdAt: db().now.toISOString(),
        expiresAt: new Date(db().now.getTime() + 86_400_000).toISOString(),
        items: input.built.items.map((item, position) => ({
          id: newId(),
          proposalId: planId,
          position,
          action: item.action,
          status: "pending",
          autoApplied: false,
          title: item.title,
          payload: clone(item.payload),
          display: clone(item.display),
          targetId: item.targetId,
          resultId: null,
          undo: null,
          error: null,
        })),
      };
      db().plans.set(planId, plan);
      return clone(plan);
    },
    listPendingBlocks: async () =>
      allItems()
        .filter((i) => i.status === "pending" && i.action === "schedule_block")
        .map((i) => ({ start: String(i.payload.startsAt), end: String(i.payload.endsAt), title: i.title, taskId: (i.payload.taskId as string | null) ?? null })),
    markAutoApplied: async (_u: string, ids: string[]) => {
      for (const i of allItems()) if (ids.includes(i.id)) i.autoApplied = true;
    },
    updateOpenItem: async (_u: string, item: { id: string }, patch: Partial<StoredItem>) => {
      const target = allItems().find((i) => i.id === item.id);
      if (!target || !["pending", "conflict", "failed"].includes(target.status)) return false;
      Object.assign(target, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return true;
    },
    rejectItems: async (_u: string, planId: string, ids: string[] | null) => {
      const out: string[] = [];
      for (const i of db().plans.get(planId)?.items ?? []) {
        if ((!ids || ids.includes(i.id)) && ["pending", "conflict", "failed"].includes(i.status)) {
          i.status = "rejected";
          out.push(i.id);
        }
      }
      return out;
    },
    supersedeItems: async (_u: string, ids: string[]) => {
      for (const i of allItems()) {
        if (ids.includes(i.id) && i.status === "pending") {
          i.status = "rejected";
          i.error = "Replaced by a newer suggestion.";
        }
      }
    },
    listOpenItemsInConversation: async () => clone(allItems().filter((i) => i.status === "pending")),
    applyPlanItems: async (_u: string, planId: string, requestId: string, ops: Record<string, unknown>[]) => {
      if (db().approvals.has(requestId)) return db().approvals.get(requestId)!;
      const plan = db().plans.get(planId)!;
      const results = ops.map((op) => {
        const item = plan.items.find((i) => i.id === op.item_id)!;
        if (item.status === "applied") return { item_id: item.id, outcome: "already_applied" };
        try {
          if (op.op === "mark_applied") {
            item.status = "applied";
            item.undo = (op.undo as Record<string, unknown>) ?? null;
            return { item_id: item.id, outcome: "applied", result_id: null };
          }
          const { resultId, undo } = applyOp(op, item);
          item.status = "applied";
          item.resultId = resultId;
          item.undo = undo as Record<string, unknown> | null;
          item.error = null;
          return { item_id: item.id, outcome: "applied", result_id: resultId };
        } catch (error) {
          const stale = (error as { stale?: boolean }).stale;
          item.status = "failed";
          item.error = (error as Error).message;
          return { item_id: item.id, outcome: stale ? "stale" : "failed", message: item.error };
        }
      });
      plan.status = planStatus(plan);
      db().approvals.set(requestId, results);
      return results;
    },
    undoPlanItem: async (itemId: string) => {
      const item = allItems().find((i) => i.id === itemId);
      if (!item) throw new Error("Item not found");
      if (item.status !== "applied" || !item.undo) throw new Error("Nothing to undo");
      undoOp(item.undo as Undo);
      item.status = "undone" as StoredItem["status"];
      const plan = db().plans.get(item.proposalId)!;
      plan.status = planStatus(plan);
    },
    getActions: async () => readActions(db().planningState),
    setActions: async (_u: string, _c: string, actions: ActionContext[]) => {
      db().planningState = clone(writeActions(actions));
    },
    getItemStates: async (_u: string, ids: string[]) =>
      allItems()
        .filter((i) => ids.includes(i.id))
        .map((i) => ({ id: i.id, status: i.status, error: i.error, resultId: i.resultId, targetId: i.targetId })),
  };
}
