import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionContext } from "@/lib/assistant/action-state";
import type { BuiltPlan } from "@/lib/assistant/build-plan";
import { validatePlannerOutput, type Draft } from "@/lib/assistant/intents";
import type { NamingContext } from "@/lib/assistant/naming";
import type { Commitment, Task } from "@/lib/domain/types";
import { defaultSchedulingPreferences } from "@/lib/scheduling/planner";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import type { StoredItem, StoredPlan } from "@/lib/db/plans";
import { AREAS, NOW, TZ, date, wire } from "@/lib/assistant/__tests__/fixtures";

/**
 * Regression scenarios A-H from real conversations, run through the real
 * orchestration (planTurn, approveItems): action state, entity resolution,
 * duplicate prevention, card building and the approval path. Only the
 * planner model (scripted below, then validated by the real code) and the
 * database (an in-memory fake that applies ops like apply_plan_items) are
 * stand-ins. The fake can be told to fail, for scenario H.
 *
 * Today is Wednesday 2026-11-18, 4 PM in Los Angeles.
 */

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

type Db = {
  events: Commitment[];
  tasks: Task[];
  plans: Map<string, StoredPlan>;
  planningState: unknown;
  approvals: Map<string, { item_id: string; outcome: string; message?: string; result_id?: string | null }[]>;
  failApply: boolean;
  failCreate: boolean;
};

let db: Db;
let seq = 0;
const id = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const clone = <T>(v: T): T => structuredClone(v);

function resetDb() {
  db = { events: [], tasks: [], plans: new Map(), planningState: null, approvals: new Map(), failApply: false, failCreate: false };
}

function applyOp(op: Record<string, unknown>): string | null {
  const row = (op.row ?? {}) as Record<string, unknown>;
  const patch = (op.patch ?? {}) as Record<string, unknown>;
  switch (op.op) {
    case "insert_commitment": {
      const ev: Commitment = {
        id: id(),
        title: String(row.title),
        area: null,
        kind: row.kind === "flexible" ? "flexible" : "fixed",
        startsAt: String(row.starts_at),
        endsAt: String(row.ends_at),
        timezone: String(row.timezone),
        recurrenceRule: (row.recurrence_rule as string | null) ?? null,
        ...(row.task_id ? { taskId: row.task_id as string, planItemId: String(op.item_id) } : {}),
      } as Commitment;
      db.events.push(ev);
      return ev.id;
    }
    case "update_event": {
      const ev = db.events.find((e) => e.id === op.id);
      if (!ev) throw new Error("Event not found");
      const expect = op.expect as Record<string, unknown>;
      if (expect && (expect.title !== ev.title || expect.starts_at !== ev.startsAt)) throw new Error("This event changed since the suggestion.");
      if ("title" in patch) ev.title = String(patch.title);
      if ("starts_at" in patch) ev.startsAt = String(patch.starts_at);
      if ("ends_at" in patch) ev.endsAt = String(patch.ends_at);
      if ("recurrence_rule" in patch) ev.recurrenceRule = patch.recurrence_rule as string | null;
      return ev.id;
    }
    case "skip_occurrence": {
      const ev = db.events.find((e) => e.id === op.id);
      if (!ev) throw new Error("Repeating event not found");
      ev.recurrenceExceptions = [...(ev.recurrenceExceptions ?? []), String(op.date)];
      return ev.id;
    }
    case "delete_block": {
      const ev = db.events.find((e) => e.id === op.id);
      if (!ev || ev.kind !== "flexible" || !ev.planItemId) throw new Error("Only sessions the assistant scheduled can be removed");
      db.events = db.events.filter((e) => e.id !== op.id);
      return String(op.id);
    }
    case "remove_task": {
      if (!db.tasks.some((t) => t.id === op.id)) throw new Error("Task not found");
      db.tasks = db.tasks.filter((t) => t.id !== op.id);
      for (const e of db.events) if (e.taskId === op.id) e.taskId = null;
      return String(op.id);
    }
    case "delete_event": {
      db.events = db.events.filter((e) => e.id !== op.id);
      return String(op.id);
    }
    case "insert_task": {
      const t: Task = {
        id: id(),
        title: String(row.title),
        area: null,
        priority: (row.priority as Task["priority"]) ?? "medium",
        status: "todo",
        dueAt: (row.due_at as string | null) ?? null,
        estimatedMinutes: (row.estimated_minutes as number | null) ?? null,
        repeat: (row.repeat as Task["repeat"]) ?? null,
      };
      db.tasks.push(t);
      return t.id;
    }
    case "update_task": {
      const t = db.tasks.find((x) => x.id === op.id);
      if (!t) throw new Error("Task not found");
      if (patch.status) t.status = patch.status as Task["status"];
      if (patch.title) t.title = String(patch.title);
      if ("due_at" in patch) t.dueAt = (patch.due_at as string | null) ?? null;
      if ("repeat" in patch) t.repeat = (patch.repeat as Task["repeat"]) ?? null;
      if (patch.occurrence_done) t.status = "todo";
      return t.id;
    }
    default:
      throw new Error(`Unknown operation ${String(op.op)}`);
  }
}

function allItems(): StoredItem[] {
  return [...db.plans.values()].flatMap((p) => p.items);
}

function planStatus(plan: StoredPlan): StoredPlan["status"] {
  const s = plan.items.map((i) => i.status);
  const open = s.filter((x) => x === "pending" || x === "conflict" || x === "failed").length;
  const applied = s.filter((x) => x === "applied").length;
  return open === 0 && applied > 0 ? "applied" : applied > 0 ? "partially_applied" : open === 0 && s.length ? "rejected" : "pending";
}

vi.mock("@/lib/db/plans", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/plans")>();
  const { readActions, writeActions } = await import("@/lib/assistant/action-state");
  return {
    ...real,
    getPlan: async (_u: string, planId: string) => {
      const p = db.plans.get(planId);
      if (!p) throw new Error("Plan not found");
      return clone(p);
    },
    createPlan: async (_u: string, input: { conversationId: string | null; sourceMessageId: string | null; built: BuiltPlan; now?: Date }) => {
      if (db.failCreate) throw Object.assign(new Error('new row for relation "plan_items" violates check constraint "plan_items_action_check"'), { name: "DatabaseError", code: "23514" });
      const planId = id();
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
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
        items: input.built.items.map((item, position) => ({
          id: id(),
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
      db.plans.set(planId, plan);
      return clone(plan);
    },
    listPendingBlocks: async () => [],
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
      for (const i of db.plans.get(planId)?.items ?? []) {
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
      if (db.approvals.has(requestId)) return db.approvals.get(requestId)!;
      const plan = db.plans.get(planId)!;
      const results = ops.map((op) => {
        const item = plan.items.find((i) => i.id === op.item_id)!;
        if (item.status === "applied") return { item_id: item.id, outcome: "already_applied" };
        if (db.failApply) {
          item.status = "failed";
          item.error = "could not reach the database";
          return { item_id: item.id, outcome: "failed", message: item.error };
        }
        try {
          const resultId = op.op === "mark_applied" ? null : applyOp(op);
          item.status = "applied";
          item.resultId = resultId;
          item.error = null;
          return { item_id: item.id, outcome: "applied", result_id: resultId };
        } catch (error) {
          item.status = "failed";
          item.error = (error as Error).message;
          return { item_id: item.id, outcome: "failed", message: item.error };
        }
      });
      plan.status = planStatus(plan);
      db.approvals.set(requestId, results);
      return results;
    },
    getActions: async () => readActions(db.planningState),
    setActions: async (_u: string, _c: string, actions: ActionContext[]) => {
      db.planningState = clone(writeActions(actions));
    },
    getItemStates: async (_u: string, ids: string[]) =>
      allItems()
        .filter((i) => ids.includes(i.id))
        .map((i) => ({ id: i.id, status: i.status, error: i.error, resultId: i.resultId, targetId: i.targetId })),
  };
});

vi.mock("@/lib/db/scheduling", () => ({
  loadSchedulingBase: async () => ({
    timeZone: TZ,
    preferences: defaultSchedulingPreferences({ dayStartTime: "07:00", dayEndTime: "22:30" }),
    events: clone(db.events),
    openTasks: clone(db.tasks.filter((t) => t.status !== "done")),
  }),
}));
vi.mock("@/lib/db/profiles", () => ({ getPreferences: async () => ({ weekStartsOn: 1 }) }));
vi.mock("@/lib/db/life-areas", () => ({ listLifeAreas: async () => AREAS }));
vi.mock("@/lib/db/habits", () => ({ listActiveHabits: async () => [] }));
vi.mock("@/lib/db/goals", () => ({ listGoals: async () => [] }));
vi.mock("@/lib/db/scheduling-preferences", () => ({
  getSchedulingPreferences: async () => defaultSchedulingPreferences({ dayStartTime: "07:00", dayEndTime: "22:30" }),
  saveSchedulingPreferences: async (_u: string, p: unknown) => p,
}));

// The planner model: scripted per turn, then validated by the real code.
let script: { wires: ReturnType<typeof wire>[] | ((actions: ActionContext[]) => ReturnType<typeof wire>[]) } = { wires: [] };
let lastPrompt = "";
vi.mock("@/lib/ai/service", () => ({
  interpretMessage: async (input: { userMessage: string; drafts: Draft[]; naming?: NamingContext; prompt: string }) => {
    lastPrompt = input.prompt;
    const { readActions } = await import("@/lib/assistant/action-state");
    const wires = typeof script.wires === "function" ? script.wires(readActions(db.planningState)) : script.wires;
    return validatePlannerOutput({ intents: wires, question: null }, { userText: input.userMessage, drafts: input.drafts, naming: input.naming });
  },
}));

const { planTurn, approveItems } = await import("../plan-service");

// ---------------------------------------------------------------------------
// Conversation driver
// ---------------------------------------------------------------------------

let history: { role: "user" | "assistant"; content: string }[] = [];

async function say(text: string, wires: typeof script.wires) {
  script = { wires };
  const result = await planTurn({
    userId: "u1",
    conversationId: "c1",
    userMessageId: id(),
    userText: text,
    history: [...history, { role: "user", content: text }],
    now: NOW,
  });
  history.push({ role: "user", content: text }, { role: "assistant", content: result.clarify?.question ?? "Card's below." });
  return result;
}

const actions = () => (db.planningState as { actions: ActionContext[] }).actions;
const open = () => allItems().filter((i) => i.status === "pending" || i.status === "conflict");
const local = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const at = (day: string, time: string) => zonedToUtc(day, time, TZ).toISOString();

function addEvent(title: string, day: string, start: string, end: string, rrule: string | null = null): Commitment {
  const ev: Commitment = { id: id(), title, area: null, kind: "fixed", startsAt: at(day, start), endsAt: at(day, end), timezone: TZ, recurrenceRule: rrule };
  db.events.push(ev);
  return ev;
}

/** A work session the assistant scheduled (flexible, with a plan item). */
function addSession(title: string, day: string, start: string, end: string, taskId: string | null = null): Commitment {
  const ev: Commitment = { id: id(), title, area: null, kind: "flexible", startsAt: at(day, start), endsAt: at(day, end), timezone: TZ, recurrenceRule: null, planItemId: id(), taskId };
  db.events.push(ev);
  return ev;
}

function addTask(title: string): Task {
  const t: Task = { id: id(), title, area: null, priority: "medium", status: "todo", dueAt: null, estimatedMinutes: null };
  db.tasks.push(t);
  return t;
}

beforeEach(() => {
  resetDb();
  history = [];
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("Scenario A: tutoring, refined over three messages", () => {
  async function firstTwoTurns() {
    const t1 = await say("I have to tutor a kid tomorrow for an hour.", [
      wire({ type: "create_event", title: "Tutoring Session", evidence: "tutor a kid tomorrow for an hour", date: date({ day_offset: 1 }), duration_minutes: 60 }),
    ]);
    expect(t1.clarify?.field).toBe("time");
    expect(t1.plan).toBeNull();

    const t2 = await say("5pm", (a) => [wire({ type: "create_event", draft_id: a[0].id, evidence: "5pm", start_time: "17:00" })]);
    expect(t2.clarify).toBeNull();
    expect(t2.plan?.items).toHaveLength(1);
    expect(t2.plan?.items[0]).toMatchObject({ action: "create_event", title: "Tutoring Session" });
    expect(local(t2.plan!.items[0].timing!.start)).toBe("2026-11-19, 17:00");
    expect(t2.plan!.items[0].timing!.durationMinutes).toBe(60);
    return t2;
  }

  it("'It's math tutoring' renames the same proposal (model links it)", async () => {
    await firstTwoTurns();
    const t3 = await say("It's math tutoring.", (a) => [wire({ type: "create_event", draft_id: a[0].id, title: "Math Tutoring", evidence: "math tutoring" })]);
    expect(t3.clarify).toBeNull();
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({ action: "create_event", title: "Math Tutoring" });
    expect(local(String(open()[0].payload.startsAt))).toBe("2026-11-19, 17:00");
    expect(local(String(open()[0].payload.endsAt))).toBe("2026-11-19, 18:00");
    expect(actions().filter((x) => x.status === "proposed")).toHaveLength(1);
    expect(db.events).toHaveLength(0);
  });

  it("'It's math tutoring' still lands on the same proposal when the model doesn't link it", async () => {
    await firstTwoTurns();
    const t3 = await say("It's math tutoring.", [wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring" })]);
    expect(t3.clarify).toBeNull();
    expect(open()).toHaveLength(1);
    expect(open()[0].title).toBe("Math Tutoring");
    expect(local(String(open()[0].payload.startsAt))).toBe("2026-11-19, 17:00");
    expect(actions()[0].corrections).toEqual(["It's math tutoring."]);
  });
});

describe("Scenario B: correcting a date", () => {
  it("'Actually, Saturday' moves the same proposal, no second event, no repeat question", async () => {
    await say("Chem study group this Friday at 4 for 2 hours", [
      wire({ type: "create_event", title: "Chemistry Study Group", evidence: "Chem study group this Friday at 4 for 2 hours", date: date({ weekday: "fr", week: "this" }), start_time: "16:00", duration_minutes: 120 }),
    ]);
    expect(open()).toHaveLength(1);
    const t2 = await say("Actually, Saturday.", (a) => [wire({ type: "create_event", draft_id: a[0].id, evidence: "Saturday", date: date({ weekday: "sa" }) })]);
    expect(t2.clarify).toBeNull();
    expect(open()).toHaveLength(1);
    expect(local(String(open()[0].payload.startsAt))).toBe("2026-11-21, 16:00");
    expect(local(String(open()[0].payload.endsAt))).toBe("2026-11-21, 18:00");
  });
});

describe("Scenario C: correcting an existing event", () => {
  it("renames 'Tutor a kid' instead of creating Math Tutoring", async () => {
    const ev = addEvent("Tutor a kid", "2026-11-19", "17:00", "18:00");
    const t = await say("The tutor a kid that's math tutoring.", [
      wire({ type: "update_event", target_ref: "e1", target_name: "tutor a kid", title: "Math Tutoring", evidence: "tutor a kid that's math tutoring" }),
    ]);
    expect(t.plan?.items.map((i) => i.action)).toEqual(["update_event"]);
    expect(t.plan?.items[0]).toMatchObject({ title: "Tutor a kid", targetId: ev.id, detail: 'Rename to "Math Tutoring"' });
    await approveItems("u1", t.plan!.id, { requestId: id(), now: NOW });
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ title: "Math Tutoring", startsAt: ev.startsAt, endsAt: ev.endsAt });
  });

  it("'Move basketball to 6' on a repeating event asks once, then changes just that day", async () => {
    const practice = addEvent("Basketball Practice", "2026-09-01", "17:00", "19:00", "FREQ=WEEKLY;BYDAY=TU,TH");
    const t1 = await say("Move basketball to 6", [wire({ type: "update_event", target_ref: "e1", target_name: "basketball", evidence: "Move basketball to 6", start_time: "18:00" })]);
    expect(t1.clarify?.question).toBe("Just this week, or every week?");
    const t2 = await say("Just this week", (a) => [wire({ type: "update_event", draft_id: a[0].id, evidence: "Just this week", scope: "one" })]);
    expect(t2.plan?.items.map((i) => i.action)).toEqual(["skip_occurrence", "create_event"]);
    expect(local(t2.plan!.items[1].timing!.start)).toBe("2026-11-19, 18:00");
    expect(local(t2.plan!.items[1].timing!.end)).toBe("2026-11-19, 20:00");
    expect(practice.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
  });
});

describe("Scenario D: completing a task that doesn't exist", () => {
  it("never completes an unrelated task, even when the model points at one", async () => {
    const chem = addTask("Chemistry Homework");
    addTask("History Essay");
    const t = await say("Mark training as done.", [
      wire({ type: "complete_task", target_ref: "t1", target_name: "training", title: "Training", evidence: "Mark training as done", explicit: true }),
    ]);
    expect(t.plan).toBeNull();
    expect(t.actions).toContain('Nothing called "training"');
    expect(chem.status).toBe("todo");
    expect(db.tasks.every((x) => x.status === "todo")).toBe(true);
  });

  it("a real match is checked off right away, with Undo on the card", async () => {
    const chem = addTask("Chemistry Homework");
    const t = await say("Mark chem done", [wire({ type: "complete_task", target_ref: "t1", target_name: "chem", evidence: "Mark chem done", explicit: true })]);
    expect(t.plan?.items[0]).toMatchObject({ action: "complete_task", status: "applied", targetId: chem.id });
    expect(db.tasks[0].status).toBe("done");
  });

  it("'I finished all the tasks yesterday' checks all four off in one message, no confirm step", async () => {
    const tasks = ["Math Test Studying", "Take out the trash", "Find quotes for room", "Email Michael Wu"].map(addTask);
    const session = addSession("Math Test Studying", "2026-11-19", "16:00", "17:00", tasks[0].id);
    // Not phrased as a command, so the model marks it explicit=false.
    const t = await say(
      "i finished all the tasks yesterday",
      tasks.map((_, n) => wire({ type: "complete_task", target_ref: `t${n + 1}`, target_name: "all the tasks", evidence: "finished all the tasks", explicit: false })),
    );
    expect(t.clarify).toBeNull();
    expect(db.tasks.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(t.plan?.items.filter((i) => i.action === "complete_task").every((i) => i.status === "applied")).toBe(true);
    expect(t.actions).not.toMatch(/NOT saved[^]*complete task/);
    // Calendar sessions are untouched until approved (freeing the leftover one is suggested).
    expect(db.events.map((e) => e.id)).toContain(session.id);
  });
});

describe("Scenario E: repeated instructions", () => {
  it("a direct add is saved at once, and the same request again adds nothing", async () => {
    const add = () =>
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60, explicit: true });
    // A direct "add" is saved right away (with Undo); a "yes" after it changes nothing more.
    const first = await say("Add math tutoring tomorrow at 5 for an hour", [add()]);
    expect(first.actions).toContain("Already done");
    expect(db.events.map((e) => e.title)).toEqual(["Math Tutoring"]);
    const yes = await say("yes", (a) => [wire({ type: "confirm_action", draft_id: a[0].id, evidence: "yes" })]);
    expect(db.events.map((e) => e.title)).toEqual(["Math Tutoring"]);
    expect(yes.actions).toContain("saved");
    expect(actions()[0].status).toBe("saved");

    const again = await say("Add math tutoring tomorrow at 5 for an hour", [add()]);
    expect(again.plan).toBeNull();
    expect(again.actions).toMatch(/already (saved|on the calendar)/);
    expect(db.events).toHaveLength(1);
  });

  it("an event already on the calendar isn't proposed twice", async () => {
    addEvent("Math Tutoring", "2026-11-19", "17:00", "18:00");
    const t = await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    expect(t.plan).toBeNull();
    expect(t.actions).toContain("already on the calendar");
  });
});

describe("Scenario F: existing task context", () => {
  it("'Schedule an hour for that tomorrow' books a linked session for the task just added", async () => {
    await say("Add a task: history essay due Friday", [
      wire({ type: "create_task", title: "History Essay", evidence: "history essay due Friday", deadline: date({ weekday: "fr" }), explicit: true }),
    ]);
    expect(db.tasks.map((t) => t.title)).toEqual(["History Essay"]);
    const essay = db.tasks[0];
    const t = await say("Schedule an hour for that tomorrow.", [
      wire({ type: "plan_time", title: "History Essay", target_name: "that", evidence: "Schedule an hour for that tomorrow", amount_kind: "single", amount_minutes: 60, window: "tomorrow" }),
    ]);
    const blocks = t.plan?.items.filter((i) => i.action === "schedule_block") ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].timing?.date).toBe("2026-11-19");
    const stored = allItems().find((i) => i.id === blocks[0].id)!;
    expect(stored.payload.taskId).toBe(essay.id);
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].status).toBe("todo");
  });
});

describe("Scenario G: ambiguous references", () => {
  it("'Move that to Friday' with two basketball games asks which one", async () => {
    addEvent("Basketball Game", "2026-11-19", "18:00", "20:00");
    addEvent("Basketball Game", "2026-11-21", "18:00", "20:00");
    history.push({ role: "user", content: "I have two basketball games this week" }, { role: "assistant", content: "Busy week." });
    const t = await say("Move that to Friday.", [wire({ type: "update_event", target_ref: "e1", target_name: "that", evidence: "Move that to Friday", date: date({ weekday: "fr" }) })]);
    expect(t.plan).toBeNull();
    expect(t.clarify?.field).toBe("target");
    expect(t.clarify?.choices).toEqual(["Basketball Game (Thu, Nov 19)", "Basketball Game (Sat, Nov 21)"]);
    expect(db.events.map((e) => local(e.startsAt!))).toEqual(["2026-11-19, 18:00", "2026-11-21, 18:00"]);
  });
});

describe("Scenario H: failure handling", () => {
  it("a failed save is reported as failed, never as done", async () => {
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    db.failApply = true;
    const yes = await say("yes add it", (a) => [wire({ type: "confirm_action", draft_id: a[0].id, evidence: "yes add it" })]);
    expect(db.events).toHaveLength(0);
    expect(yes.actions).toContain("NOT saved");
    expect(yes.actions).not.toContain("confirmed it is saved");

    db.failApply = false;
    const next = await say("ok thanks", []);
    expect(next.actions).toContain("saving failed");
    expect(next.actions).toContain("Nothing changed");
  });
});

describe("Scenario H2: retrying after a storage error", () => {
  it("a card that couldn't be stored is kept, and 'try again' rebuilds it", async () => {
    const tutor = addEvent("Tutor a kid", "2026-11-14", "17:00", "18:00", "FREQ=WEEKLY;BYDAY=SA");
    const t1 = await say("Rename tutor a kid to math tutoring and move it to Friday", [
      wire({ type: "update_event", target_ref: "e1", target_name: "tutor a kid", title: "Math Tutoring", evidence: "Rename tutor a kid to math tutoring and move it to Friday", date: date({ weekday: "fr" }) }),
    ]);
    expect(t1.clarify?.question).toBe("Just this week, or every week?");

    db.failCreate = true;
    const t2 = await say("just this week", (a) => [wire({ type: "update_event", draft_id: a[0].id, evidence: "just this week", scope: "one" })]);
    expect(t2.plan).toBeNull();
    expect(t2.actions).toContain("storage error");
    expect(actions()).toHaveLength(1);
    expect(actions()[0]).toMatchObject({ status: "failed", itemIds: [] });

    db.failCreate = false;
    const t3 = await say("try again", [wire({ type: "confirm_action", evidence: "try again" })]);
    expect(t3.actions).not.toContain("nothing is waiting");
    expect(t3.plan?.items.map((i) => i.action)).toEqual(["skip_occurrence", "create_event"]);
    expect(t3.plan?.items[1].title).toBe("Math Tutoring");
    expect(local(t3.plan!.items[1].timing!.start)).toBe("2026-11-20, 17:00");
    expect(actions()[0].status).toBe("proposed");
    // Shown again for approval, not saved without a tap.
    expect(tutor.recurrenceExceptions ?? []).toEqual([]);
    expect(db.events).toHaveLength(1);
  });

  it("'try again' after an approval failed saves it, and the old card closes", async () => {
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    db.failApply = true;
    await say("yes", (a) => [wire({ type: "confirm_action", draft_id: a[0].id, evidence: "yes" })]);
    expect(actions()[0].status).toBe("failed");
    const oldItems = actions()[0].itemIds;

    db.failApply = false;
    const again = await say("try again", [wire({ type: "confirm_action", evidence: "try again" })]);
    expect(db.events).toHaveLength(1);
    expect(local(db.events[0].startsAt!)).toBe("2026-11-19, 17:00");
    expect(again.actions).toContain("database confirmed it is saved");
    expect(allItems().filter((i) => oldItems.includes(i.id)).map((i) => i.status)).toEqual(["rejected"]);

    // A second "try again" adds nothing.
    await say("try again", [wire({ type: "confirm_action", evidence: "try again" })]);
    expect(db.events).toHaveLength(1);
  });
});

describe("Beyond the scenarios", () => {
  it("fills time and length from the user's usual activity instead of asking", async () => {
    addEvent("Basketball Practice", "2026-09-01", "17:00", "19:00", "FREQ=WEEKLY;BYDAY=TU,TH");
    const t = await say("Basketball practice Saturday too, just this week", [
      wire({ type: "create_event", title: "Basketball Practice", evidence: "Basketball practice Saturday too, just this week", date: date({ weekday: "sa" }), recurrence: "once" }),
    ]);
    expect(t.clarify).toBeNull();
    expect(t.plan?.items[0].reason).toContain("Your usual time for Basketball Practice.");
    expect(local(t.plan!.items[0].timing!.start)).toBe("2026-11-21, 17:00");
    expect(local(t.plan!.items[0].timing!.end)).toBe("2026-11-21, 19:00");
  });

  it("'never mind' closes the open card", async () => {
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    await say("never mind", (a) => [wire({ type: "cancel_draft", draft_id: a[0].id, evidence: "never mind" })]);
    expect(open()).toHaveLength(0);
    expect(actions()[0].status).toBe("abandoned");
  });

  it("'move that to 6' right after a card corrects the card, not a saved event", async () => {
    addEvent("Math Tutoring", "2026-11-12", "16:00", "17:00");
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    await say("Move that to 6", [wire({ type: "update_event", target_name: "that", evidence: "Move that to 6", start_time: "18:00" })]);
    expect(open()).toHaveLength(1);
    expect(open()[0].action).toBe("create_event");
    expect(local(String(open()[0].payload.startsAt))).toBe("2026-11-19, 18:00");
    expect(local(String(open()[0].payload.endsAt))).toBe("2026-11-19, 19:00");
  });

  it("the planner sees open cards with their current values", async () => {
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    await say("hmm", []);
    expect(lastPrompt).toContain("on an approval card, NOT saved yet");
    expect(lastPrompt).toContain("Math Tutoring");
  });

  it("'in two hours' is computed by the server", async () => {
    const t = await say("Study session in two hours for 45 minutes", [
      wire({ type: "create_event", title: "Study Session", evidence: "Study session in two hours for 45 minutes", start_in_minutes: 120, duration_minutes: 45 }),
    ]);
    expect(local(t.plan!.items[0].timing!.start)).toBe("2026-11-18, 18:00");
  });
});

describe("Stored conversation state", () => {
  it("stays under the database's size cap, keeping open actions", async () => {
    const { writeActions, STATE_BUDGET_CHARS } = await import("@/lib/assistant/action-state");
    await say("Add math tutoring tomorrow at 5 for an hour", [
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60 }),
    ]);
    const base = actions()[0];
    const long = "x".repeat(400);
    const many: ActionContext[] = [
      { ...base, id: "open1", status: "proposed", corrections: [long, long] },
      ...Array.from({ length: 7 }, (_, i) => ({ ...base, id: `done${i}`, status: "saved" as const, corrections: [long, long, long] })),
    ];
    const written = writeActions(many);
    expect(JSON.stringify(written).length).toBeLessThanOrEqual(STATE_BUDGET_CHARS);
    expect(written.actions[0].id).toBe("open1");
    expect(written.actions.length).toBeGreaterThan(1);
  });
});

describe("Scenario I: 'clear them' after the assistant listed leftover sessions", () => {
  // The exact reply from xavi's screenshot (2026-11-21).
  const OFFER =
    "Saturday 12-2 it is. That leaves you 10 minutes before Pre-calculus at 2:10, so go straight from one to the other. Tennis is off your calendar. " +
    "Biology Essay, Choose Topic and Gather Sources, and Draft the Body Paragraphs are still on tonight's calendar. Say the word and I'll clear them. " +
    "Is tutoring every Saturday, or just this one?";

  function setup() {
    const tutoring = addEvent("Tutoring", "2026-11-21", "12:00", "14:00");
    const precalc = addEvent("Pre-calculus Class", "2026-11-21", "14:10", "15:30");
    // Sessions whose task was already deleted: still on the calendar.
    addSession("Biology Essay", "2026-11-18", "18:00", "18:45");
    addSession("Choose Topic and Gather Sources", "2026-11-18", "19:00", "19:45");
    addSession("Draft the Body Paragraphs", "2026-11-18", "20:00", "21:00");
    history.push({ role: "user", content: "I'm tutoring Saturday 12-2, and tennis is cancelled" }, { role: "assistant", content: OFFER });
    return { tutoring, precalc };
  }

  it("'clear them' removes exactly the three listed sessions, never Pre-calculus", async () => {
    const { tutoring, precalc } = setup();
    // Worst case: the model points at Pre-calculus, which the reply only mentioned in passing.
    const t = await say("clear them", [wire({ type: "remove_event", target_ref: "e2", target_name: "them", evidence: "clear them", explicit: true })]);
    expect(t.clarify).toBeNull();
    expect(t.plan?.items.map((i) => i.title)).toEqual(["Biology Essay", "Choose Topic and Gather Sources", "Draft the Body Paragraphs"]);
    await approveItems("u1", t.plan!.id, { requestId: id(), now: NOW });
    expect(db.events.map((e) => e.id)).toEqual([tutoring.id, precalc.id]);
  });

  it("one remove per listed item (the prompt's rule) still removes all three, once each", async () => {
    setup();
    const t = await say("yeah clear them", [
      wire({ type: "remove_event", target_ref: "b1", target_name: "them", evidence: "clear them", explicit: true }),
      wire({ type: "remove_event", target_ref: "b2", target_name: "them", evidence: "clear them", explicit: true }),
      wire({ type: "remove_event", target_ref: "b3", target_name: "them", evidence: "clear them", explicit: true }),
    ]);
    expect(t.plan?.items.map((i) => i.title)).toEqual(["Biology Essay", "Choose Topic and Gather Sources", "Draft the Body Paragraphs"]);
  });

  it("'I told you to clear them a while ago' acts on the earlier offer instead of asking which", async () => {
    const { tutoring, precalc } = setup();
    history.push({ role: "user", content: "ok" }, { role: "assistant", content: "Which did you mean: Pre-calculus class or Draft the Body Paragraphs?" });
    // The model may call them tasks; they're calendar sessions, so they're removed from the calendar.
    const t = await say("bro i told you to clear them a while ago", [wire({ type: "remove_task", target_name: "them", title: "them", evidence: "clear them", explicit: true })]);
    expect(t.clarify).toBeNull();
    expect(t.plan?.items.map((i) => i.action)).toEqual(["remove_event", "remove_event", "remove_event"]);
    await approveItems("u1", t.plan!.id, { requestId: id(), now: NOW });
    expect(db.events.map((e) => e.id)).toEqual([tutoring.id, precalc.id]);
  });

  it("a named item still wins over the offer", async () => {
    setup();
    const t = await say("just clear draft the body paragraphs", [
      wire({ type: "remove_event", target_ref: "b3", target_name: "draft the body paragraphs", evidence: "clear draft the body paragraphs", explicit: true }),
    ]);
    expect(t.plan?.items.map((i) => i.title)).toEqual(["Draft the Body Paragraphs"]);
  });
});

describe("Deleting a task takes its work sessions with it", () => {
  it("'delete my history essay task' also frees its scheduled sessions", async () => {
    const essay = addTask("History Essay");
    const other = addTask("Chemistry Homework");
    addSession("History Essay", "2026-11-18", "19:00", "20:00", essay.id);
    addSession("History Essay", "2026-11-19", "19:00", "20:00", essay.id);
    const chem = addSession("Chemistry Homework", "2026-11-19", "20:00", "21:00", other.id);
    const t = await say("delete my history essay task", [wire({ type: "remove_task", target_ref: "t1", title: "history essay", evidence: "delete my history essay task", explicit: true })]);
    expect(t.plan?.items.map((i) => i.action)).toEqual(["remove_task", "remove_block", "remove_block"]);
    await approveItems("u1", t.plan!.id, { requestId: id(), now: NOW });
    expect(db.tasks.map((x) => x.title)).toEqual(["Chemistry Homework"]);
    expect(db.events.map((e) => e.id)).toEqual([chem.id]);
  });
});

describe("Scenario J: removing the Chemistry Test with study sessions around it", () => {
  function setup() {
    const test = addEvent("Chemistry Test", "2026-11-27", "09:00", "10:00");
    const mon1 = addSession("Study for Chemistry Test", "2026-11-23", "16:00", "17:00");
    const mon2 = addSession("Study for Chemistry Test", "2026-11-23", "19:00", "20:00");
    const wed = addSession("Study for Chemistry Test", "2026-11-25", "16:00", "17:00");
    return { test, mon1, mon2, wed };
  }

  it("'remove the chemistry test' removes the test itself, no question", async () => {
    const { test } = setup();
    const t = await say("remove the chemistry test", [wire({ type: "remove_event", target_name: "chemistry test", evidence: "remove the chemistry test", explicit: true })]);
    expect(t.clarify).toBeNull();
    expect(t.plan?.items.map((i) => [i.action, i.targetId])).toEqual([["remove_event", test.id]]);
  });

  it("a vague 'remove chemistry' asks with distinct choices plus 'All of them', and that choice removes all four", async () => {
    const { test } = setup();
    const t = await say("remove chemistry", [wire({ type: "remove_event", target_name: "chemistry", evidence: "remove chemistry", explicit: true })]);
    expect(t.clarify?.field).toBe("target");
    const choices = t.clarify!.choices!;
    expect(new Set(choices).size).toBe(choices.length);
    expect(choices).toContain("Study for Chemistry Test (Mon, Nov 23, 4 PM)");
    expect(choices).toContain("Study for Chemistry Test (Mon, Nov 23, 7 PM)");
    expect(choices.at(-1)).toBe("All of them");

    const all = await say("All of them", (a) => [wire({ type: "remove_event", draft_id: a[0].id, target_ref: "e1", target_name: "all of them", evidence: "All of them", explicit: true })]);
    expect(all.clarify).toBeNull();
    expect(all.plan?.items.map((i) => i.title).sort()).toEqual(["Chemistry Test", "Study for Chemistry Test", "Study for Chemistry Test", "Study for Chemistry Test"]);
    await approveItems("u1", all.plan!.id, { requestId: id(), now: NOW });
    expect(db.events.map((e) => e.id)).not.toContain(test.id);
    expect(db.events).toHaveLength(0);
  });
});

describe("Scenario K: 'remove duplicates, keep the Google one' just happens", () => {
  function google(title: string, day: string, start: string, end: string): Commitment {
    const ev: Commitment = {
      id: id(), title, area: null, kind: "fixed", startsAt: at(day, start), endsAt: at(day, end), timezone: TZ, recurrenceRule: null,
      externalSource: "google", externalCalendarId: "primary", externalId: `g${seq}`,
    } as Commitment;
    db.events.push(ev);
    return ev;
  }

  it("removes the Whitespace copies, keeps every Google event, no confirm step", async () => {
    const g1 = google("Devsmita Das: Tutoring RSM Burlingame", "2026-11-19", "09:30", "10:30");
    const g2 = google("AoPS LA Assessment @11 AM - 12 PM", "2026-11-19", "10:30", "12:30");
    const g3 = google("Lalitha Ramanathan: Tutoring RSM Burlingame", "2026-11-19", "13:00", "14:00");
    const g4 = google("Volleyball", "2026-11-20", "16:00", "18:00");
    const dupe1 = addEvent("Math Tutoring", "2026-11-19", "09:30", "10:30");
    const dupe2 = addEvent("Language Assessment", "2026-11-19", "10:30", "12:30");
    // Repeating every Thursday: only this week's copy goes.
    const weekly = addEvent("Math Tutoring", "2026-11-05", "13:00", "14:00", "FREQ=WEEKLY;BYDAY=TH");
    const keepMine = addEvent("Pre-calculus Class", "2026-11-21", "14:10", "15:30");
    const session = addSession("Study for Chemistry Test", "2026-11-20", "16:00", "17:00");

    const t = await say(
      "can you check everything in my calendar this whole week and if you see duplicates choose the one from google calendar. most of them are duplicates so just keep the one from google calendar",
      [wire({ type: "remove_duplicates", evidence: "if you see duplicates choose the one from google calendar", window: "this_week", explicit: true })],
    );
    expect(t.clarify).toBeNull();
    expect(t.plan?.items.every((i) => i.status === "applied")).toBe(true);
    expect(t.plan?.items.map((i) => [i.action, i.title])).toEqual([
      ["remove_event", "Math Tutoring"],
      ["remove_event", "Language Assessment"],
      ["skip_occurrence", "Math Tutoring"],
    ]);
    const ids = db.events.map((e) => e.id);
    for (const g of [g1, g2, g3, g4]) expect(ids).toContain(g.id);
    expect(ids).not.toContain(dupe1.id);
    expect(ids).not.toContain(dupe2.id);
    expect(ids).toContain(keepMine.id);
    expect(ids).toContain(session.id);
    expect(db.events.find((e) => e.id === weekly.id)?.recurrenceExceptions).toEqual(["2026-11-19"]);
    expect(t.actions).toContain("Undo is on the card");
  });

  it("nothing doubled: says so and removes nothing", async () => {
    google("Volleyball", "2026-11-20", "16:00", "18:00");
    addEvent("Pre-calculus Class", "2026-11-21", "14:10", "15:30");
    const t = await say("remove duplicates this week", [wire({ type: "remove_duplicates", evidence: "remove duplicates this week", window: "this_week", explicit: true })]);
    expect(t.plan).toBeNull();
    expect(t.actions).toContain("none found");
    expect(db.events).toHaveLength(2);
  });
});

describe("Direct commands happen now; Whitespace's suggestions wait", () => {
  it("'remove the dentist appointment' removes it right away", async () => {
    const dentist = addEvent("Dentist", "2026-11-20", "10:00", "11:00");
    const t = await say("remove the dentist appointment", [wire({ type: "remove_event", target_ref: "e1", target_name: "dentist appointment", evidence: "remove the dentist appointment", explicit: true })]);
    expect(t.plan?.items[0]).toMatchObject({ action: "remove_event", status: "applied", targetId: dentist.id });
    expect(db.events).toHaveLength(0);
  });

  it("a Google event is never removed, even when named", async () => {
    const g = { id: id(), title: "Volleyball", area: null, kind: "fixed", startsAt: at("2026-11-20", "16:00"), endsAt: at("2026-11-20", "18:00"), timezone: TZ, recurrenceRule: null, externalSource: "google", externalCalendarId: "primary", externalId: "gv" } as Commitment;
    db.events.push(g);
    const t = await say("remove volleyball", [wire({ type: "remove_event", target_ref: "e1", target_name: "volleyball", evidence: "remove volleyball", explicit: true })]);
    expect(t.plan).toBeNull();
    expect(t.actions).toContain("Google Calendar");
    expect(db.events).toHaveLength(1);
  });
});

describe("Scenario L: xavi's calendar, Google copies with different names", () => {
  function google(title: string, day: string, start: string, end: string): Commitment {
    const ev = {
      id: id(), title, area: null, kind: "fixed", startsAt: at(day, start), endsAt: at(day, end), timezone: TZ, recurrenceRule: null,
      externalSource: "google", externalCalendarId: "primary", externalId: `g${seq}`,
    } as Commitment;
    db.events.push(ev);
    return ev;
  }

  it("'remove every single duplicate on the calendar' matches by time slot, not by name", async () => {
    // Debate repeats every Saturday in Whitespace, and Google has every one of them.
    const debate = addEvent("Debate", "2026-10-03", "09:00", "11:00", "FREQ=WEEKLY;BYDAY=SA");
    for (let d = Date.parse("2026-11-21T12:00:00Z"); d < Date.parse("2027-01-20T00:00:00Z"); d += 7 * 86_400_000) {
      google("Athena Speech & Debate", new Date(d).toISOString().slice(0, 10), "09:00", "11:00");
    }
    // Pre-calculus repeats; Google only has this Saturday's class.
    const precalc = addEvent("Pre-calculus", "2026-10-03", "14:10", "16:40", "FREQ=WEEKLY;BYDAY=SA");
    google("Xavier: Precalc w/ Mr. Lee", "2026-11-21", "14:10", "16:40");
    // One-time copy, Google's is shorter and more specific.
    const tutoring = addEvent("Math Tutoring", "2026-11-21", "12:00", "14:00");
    google("Christine Wu: Tutoring RSM Burlingame", "2026-11-21", "12:00", "13:00");
    google("Offer letter call", "2026-11-21", "13:00", "14:00");
    // Earlier this week (already past) and a later one.
    const coding = addEvent("Coding Club", "2026-10-06", "17:00", "18:00", "FREQ=WEEKLY;BYDAY=TU");
    google("Xavier: CS Club", "2026-11-17", "17:00", "18:00");
    const piano = addEvent("Piano", "2026-10-06", "19:00", "20:00", "FREQ=WEEKLY;BYDAY=TU");
    google("Piano Lesson", "2026-12-01", "19:00", "20:00");
    // Not duplicates: different slot, or a short event inside a long one that starts hours apart.
    const club = addEvent("Math Club Meeting", "2026-11-17", "12:00", "13:00");
    google("BHS Robotics", "2026-11-18", "15:35", "20:00");
    const check = addEvent("Check School Assignments", "2026-11-18", "18:30", "19:00");
    const thursday = addEvent("Math Tutoring", "2026-11-19", "17:00", "18:00");
    const session = addSession("Choose Topic and Gather Sources", "2026-11-21", "09:30", "10:30");
    const googleIds = db.events.filter((e) => e.externalSource).map((e) => e.id);

    const t = await say("can you remove every single duplicate on the calendar, and keep the one from google calendar", [
      wire({ type: "remove_duplicates", evidence: "remove every single duplicate on the calendar", explicit: true }),
    ]);
    expect(t.clarify).toBeNull();
    expect(t.plan?.items.every((i) => i.status === "applied")).toBe(true);
    expect(t.plan?.items.map((i) => [i.action, i.title]).sort()).toEqual([
      ["remove_event", "Debate"],
      ["remove_event", "Math Tutoring"],
      ["skip_occurrence", "Coding Club"],
      ["skip_occurrence", "Piano"],
      ["skip_occurrence", "Pre-calculus"],
    ]);
    const ids = db.events.map((e) => e.id);
    for (const g of googleIds) expect(ids).toContain(g);
    expect(ids).not.toContain(debate.id);
    expect(ids).not.toContain(tutoring.id);
    for (const kept of [precalc, coding, piano, club, check, thursday, session]) expect(ids).toContain(kept.id);
    expect(db.events.find((e) => e.id === precalc.id)?.recurrenceExceptions).toEqual(["2026-11-21"]);
    expect(db.events.find((e) => e.id === coding.id)?.recurrenceExceptions).toEqual(["2026-11-17"]);
    expect(db.events.find((e) => e.id === piano.id)?.recurrenceExceptions).toEqual(["2026-12-01"]);
    expect(t.actions).toContain("Checked every event from");

    // Asking again re-checks the calendar instead of trusting the conversation.
    const again = await say("remove every duplicate", [wire({ type: "remove_duplicates", evidence: "remove every duplicate", explicit: true })]);
    expect(again.plan).toBeNull();
    expect(again.actions).toContain("none found");
  });
});
