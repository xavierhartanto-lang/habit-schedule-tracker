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
      };
      db.tasks.push(t);
      return t.id;
    }
    case "update_task": {
      const t = db.tasks.find((x) => x.id === op.id);
      if (!t) throw new Error("Task not found");
      if (patch.status) t.status = patch.status as Task["status"];
      if (patch.title) t.title = String(patch.title);
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

  it("a real match is proposed on a card, not saved silently", async () => {
    const chem = addTask("Chemistry Homework");
    const t = await say("Mark chem done", [wire({ type: "complete_task", target_ref: "t1", target_name: "chem", evidence: "Mark chem done", explicit: true })]);
    expect(t.plan?.items[0]).toMatchObject({ action: "complete_task", status: "pending", targetId: chem.id });
    expect(db.tasks[0].status).toBe("todo");
  });
});

describe("Scenario E: repeated instructions", () => {
  it("approve in chat, then the same request again adds nothing", async () => {
    const add = () =>
      wire({ type: "create_event", title: "Math Tutoring", evidence: "math tutoring tomorrow at 5 for an hour", date: date({ day_offset: 1 }), start_time: "17:00", duration_minutes: 60, explicit: true });
    await say("Add math tutoring tomorrow at 5 for an hour", [add()]);
    const yes = await say("yes", (a) => [wire({ type: "confirm_action", draft_id: a[0].id, evidence: "yes" })]);
    expect(db.events.map((e) => e.title)).toEqual(["Math Tutoring"]);
    expect(yes.actions).toContain("The database confirmed it is saved");
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
