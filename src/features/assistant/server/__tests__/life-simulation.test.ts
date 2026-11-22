import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Commitment } from "@/lib/domain/types";
import { validatePlannerOutput, type Draft } from "@/lib/assistant/intents";
import type { NamingContext } from "@/lib/assistant/naming";
import { defaultSchedulingPreferences } from "@/lib/scheduling/planner";
import { AREAS, date, wire } from "@/lib/assistant/__tests__/fixtures";
import { allItems, resetDb, state } from "./sim/fake-db";
import { NOW, TZ, seedWeek, addEvent, type Seed } from "./sim/world";
import { addGoogle, google, googleSnapshot, mirrorDifferences, resetGoogle } from "./sim/fake-google";

/**
 * Life simulation: everyday requests from a busy high schooler, replayed
 * against a seeded week (school, practices, Google Calendar events,
 * appointments, tasks and Whitespace work sessions) through the real
 * orchestration: planTurn -> assess -> buildPlan -> auto-apply / card ->
 * apply_plan_items -> undo. Only the planner model (scripted with the
 * output a good model gives) and the database (sim/fake-db.ts) are stand-ins.
 *
 * Every scenario checks the database afterwards, and what the reply model
 * is told happened. Rules that hold in every scenario:
 * - Google Calendar (sim/fake-google.ts) changes only when the user asked
 *   for that change directly, or approved Whitespace's suggestion; every
 *   other scenario leaves Google exactly as it was.
 * - Whitespace's copy of Google events always matches Google, after Undo too.
 * - Direct commands are done now (with Undo); only Whitespace's own ideas wait for Approve.
 *
 * Today is Wednesday 2026-11-18, 4:00 PM in Los Angeles.
 */

vi.mock("@/lib/db/plans", async (importOriginal) => {
  const { plansModule } = await import("./sim/fake-db");
  return plansModule(await importOriginal());
});
vi.mock("@/lib/db/scheduling", async () => {
  const { state } = await import("./sim/fake-db");
  return {
    loadSchedulingBase: async () => ({
      timeZone: "America/Los_Angeles",
      preferences: defaultSchedulingPreferences({ dayStartTime: "07:00", dayEndTime: "22:30" }),
      events: structuredClone(state.db.events),
      openTasks: structuredClone(state.db.tasks.filter((t) => t.status !== "done")),
    }),
  };
});
vi.mock("@/lib/db/events", () => ({ linkSessionsToTask: async () => {}, markPastSessionsDone: async () => {} }));
vi.mock("@/lib/db/profiles", () => ({ getPreferences: async () => ({ weekStartsOn: 1 }), getProfile: async () => ({ timezone: "America/Los_Angeles" }) }));
vi.mock("@/features/google/server/client", async () => {
  const { fakeClient } = await import("./sim/fake-google");
  return { googleClientFor: async () => fakeClient };
});
vi.mock("@/lib/db/google", async () => {
  const { dbGoogleModule } = await import("./sim/fake-google");
  return dbGoogleModule;
});
vi.mock("@/lib/db/life-areas", () => ({ listLifeAreas: async () => AREAS }));
vi.mock("@/lib/db/habits", () => ({ listActiveHabits: async () => [] }));
vi.mock("@/lib/db/goals", () => ({ listGoals: async () => [] }));
vi.mock("@/lib/db/scheduling-preferences", () => ({
  getSchedulingPreferences: async () => defaultSchedulingPreferences({ dayStartTime: "07:00", dayEndTime: "22:30" }),
  saveSchedulingPreferences: async (_u: string, p: unknown) => p,
}));

type Wire = ReturnType<typeof wire>;
type Model = {
  /** The ref the model sees for a record this turn (t1, e4, b2). */
  ref: (record: { id: string }) => string;
  /** Id of an open action in this conversation (the newest first). */
  action: (n?: number) => string;
};
let script: (m: Model) => Wire[] = () => [];

vi.mock("@/lib/ai/service", () => ({
  interpretMessage: async (input: { userMessage: string; drafts: Draft[]; naming?: NamingContext }) => {
    const { loadWorld } = await import("../plan-service");
    const { readActions } = await import("@/lib/assistant/action-state");
    const { world } = await loadWorld("u1", NOW);
    const byId = new Map<string, string>();
    for (const map of [world.refs.tasks, world.refs.events, world.refs.blocks] as Map<string, { id: string }>[]) {
      for (const [ref, item] of map) if (!byId.has(item.id)) byId.set(item.id, ref);
    }
    const model: Model = {
      ref: (r) => {
        const ref = byId.get(r.id);
        if (!ref) throw new Error(`The model can't see record ${r.id}`);
        return ref;
      },
      action: (n = 0) => {
        const list = [...readActions(state.db.planningState)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        return list[n]?.id ?? "";
      },
    };
    return validatePlannerOutput({ intents: script(model), question: null }, { userText: input.userMessage, drafts: input.drafts, naming: input.naming });
  },
}));

const { planTurn, approveItems } = await import("../plan-service");

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** A wire intent, explicit by default (most messages are direct asks). */
function w(type: Wire["type"], evidence: string, o: Partial<Wire> & Record<string, unknown> = {}): Wire {
  return wire({ type, evidence, explicit: true, ...o } as Parameters<typeof wire>[0]);
}

let history: { role: "user" | "assistant"; content: string }[] = [];
let s: Seed;
let googleBefore: string;
let turnNo = 0;

type Turn = Awaited<ReturnType<typeof planTurn>>;

async function say(text: string, model: (m: Model) => Wire[], reply?: string): Promise<Turn & { said: string }> {
  script = model;
  const result = await planTurn({
    userId: "u1",
    conversationId: "c1",
    userMessageId: `30000000-0000-4000-8000-${String(++turnNo).padStart(12, "0")}`,
    userText: text,
    history: [...history, { role: "user", content: text }],
    now: NOW,
  });
  history.push({ role: "user", content: text }, { role: "assistant", content: reply ?? result.clarify?.question ?? "Done." });
  if (process.env.SIM_DEBUG) {
    console.log(`\n> ${text}\n${result.clarify ? `? ${result.clarify.question}\n` : ""}${result.actions ?? "(nothing)"}\nitems: ${allItems().map((i) => `${i.action}:${i.title}:${i.status}`).join(" | ")}`);
  }
  return { ...result, said: result.actions ?? "" };
}

const ev = (e: { id: string }): Commitment | undefined => state.db.events.find((x) => x.id === e.id);
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso))
    .replace(",", "");
const when = (e: { id: string }) => {
  const x = ev(e);
  return x ? `${fmt(x.startsAt!)}-${fmt(x.endsAt!).slice(11)}` : "gone";
};
const skipped = (e: { id: string }) => ev(e)?.recurrenceExceptions ?? [];
const task = (t: { id: string }) => state.db.tasks.find((x) => x.id === t.id);
const pending = () => allItems().filter((i) => i.status === "pending" || i.status === "conflict");
const applied = () => allItems().filter((i) => i.status === "applied");
const named = (title: string) => state.db.events.filter((e) => e.title === title);
/** Clock times of every Debate Club occurrence Whitespace holds (all from Google). */
const debateTimes = () => [...new Set(named("Debate Club").map((e) => when(e).slice(11)))];
/** Whether Google still holds the occurrence Whitespace's row points at. */
const inGoogle = (e: Commitment) => {
  const row = e as Commitment & { externalCalendarId?: string; externalId?: string };
  return [...google.events.values()].some((g) => g.calendarId === row.externalCalendarId && g.id === row.externalId && g.status !== "cancelled");
};

/** Undo every item applied in the newest plan, through the real undo path. */
async function undoLatest() {
  const { undoItem } = await import("../plan-service");
  const plan = [...state.db.plans.values()].at(-1)!;
  for (const i of plan.items.filter((x) => x.status === "applied")) await undoItem("u1", plan.id, i.id, NOW);
}

/** Set by scenarios where the user asked for (or approved) a Google change. */
let googleMayChange = false;
/** Set by scenarios where Whitespace suggests a Google change on a card (waits for Approve). */
let googleSuggestionOk = false;
const expectGoogleChange = () => {
  googleMayChange = true;
};

beforeEach(() => {
  resetDb(NOW);
  resetGoogle();
  history = [];
  s = seedWeek();
  googleBefore = googleSnapshot();
  googleMayChange = false;
  googleSuggestionOk = false;
});

afterEach(() => {
  // Rule 1: Google changes only when the user asked for it (or approved it).
  if (!googleMayChange) expect(googleSnapshot()).toBe(googleBefore);
  // Rule 2: Whitespace's copy of Google always matches Google.
  expect(mirrorDifferences()).toEqual([]);
  // Rule 3: a suggestion that would change Google waits on a card only where the scenario expects one.
  if (!googleSuggestionOk) {
    const googleIds = new Set(state.db.events.filter((e) => e.externalSource).map((e) => e.id));
    expect(pending().filter((i) => i.targetId && googleIds.has(i.targetId)).map((i) => `${i.action}: ${i.title}`)).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

describe("Adding things", () => {
  it("add 1. 'Add a study group Saturday 1-3pm' is saved now; the session it lands on moves (Whitespace's idea, so a card)", async () => {
    const r = await say("Add a study group Saturday 1-3pm", () => [
      w("create_event", "Add a study group Saturday 1-3pm", { title: "Study Group", date: date({ weekday: "sa" }), start_time: "13:00", end_time: "15:00", recurrence: "once" }),
    ]);
    const added = named("Study Group");
    expect(added).toHaveLength(1);
    expect(when(added[0])).toBe("2026-11-21 13:00-15:00");
    expect(r.said).toContain("Already done");
    expect(pending().map((i) => `${i.action}:${i.title}`)).toEqual(["move_block:College Essay Draft"]);
    expect(when(s.collegeSession)).toBe("2026-11-21 14:00-16:00");
  });

  it("add 2. 'I have a physics test Friday at 10' is a statement: a card, and School is never skipped for a test during school", async () => {
    await say("I have a physics test Friday at 10", () => [
      w("create_event", "I have a physics test Friday at 10", { explicit: false, title: "Physics Test", date: date({ weekday: "fr" }), start_time: "10:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(named("Physics Test")).toHaveLength(0);
    expect(pending().some((i) => i.action === "create_event" && i.title === "Physics Test")).toBe(true);
    expect(pending().filter((i) => i.action === "skip_occurrence")).toEqual([]);
    expect(skipped(s.school)).toEqual([]);
  });

  it("add 3. 'Add a basketball game next Tuesday 6-8pm' is saved; skipping that day's practice is proposed, not done", async () => {
    const r = await say("Add a basketball game next Tuesday 6-8pm", () => [
      w("create_event", "Add a basketball game next Tuesday 6-8pm", { title: "Basketball Game", date: date({ weekday: "tu", week: "next" }), start_time: "18:00", end_time: "20:00", recurrence: "once" }),
    ]);
    expect(when(named("Basketball Game")[0])).toBe("2026-11-24 18:00-20:00");
    expect(skipped(s.basketball)).toEqual([]);
    expect(pending().map((i) => `${i.action}:${i.title}`)).toEqual(["skip_occurrence:Basketball Practice"]);
    expect(r.said).toMatch(/skipping Basketball Practice/i);
  });

  it("add 4. 'Add SAT tutoring every Monday at 4 for an hour' saves a weekly event now", async () => {
    await say("Add SAT tutoring every Monday at 4 for an hour", () => [
      w("create_event", "Add SAT tutoring every Monday at 4 for an hour", { title: "SAT Tutoring", recurrence: "weekly", days: ["mo"], start_time: "16:00", duration_minutes: 60 }),
    ]);
    const e = named("SAT Tutoring")[0];
    expect(e?.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(when(e)).toBe("2026-11-23 16:00-17:00");
  });

  it("add 5. a missing time is asked once; the answer saves it without a second confirmation", async () => {
    const t1 = await say("Add a meeting with my counselor tomorrow for 20 minutes", () => [
      w("create_event", "Add a meeting with my counselor tomorrow for 20 minutes", { title: "Counselor Meeting", date: date({ day_offset: 1 }), duration_minutes: 20, recurrence: "once" }),
    ]);
    expect(t1.clarify?.field).toBe("time");
    await say("4:35", (m) => [w("create_event", "4:35", { draft_id: m.action(), start_time: "16:35", explicit: false })]);
    expect(when(named("Counselor Meeting")[0])).toBe("2026-11-19 16:35-16:55");
    expect(pending()).toEqual([]);
  });

  it("add 6. 'Add a call with grandma in 2 hours for 30 min' lands at 6 PM today", async () => {
    await say("Add a call with grandma in 2 hours for 30 min", () => [
      w("create_event", "Add a call with grandma in 2 hours for 30 min", { title: "Call with Grandma", start_in_minutes: 120, duration_minutes: 30 }),
    ]);
    expect(when(named("Call with Grandma")[0])).toBe("2026-11-18 18:00-18:30");
  });

  it("add 7. adding piano lesson again does not make a duplicate", async () => {
    const r = await say("Add piano lesson every Wednesday at 6:30", () => [
      w("create_event", "Add piano lesson every Wednesday at 6:30", { title: "Piano Lesson", recurrence: "weekly", days: ["we"], start_time: "18:30", duration_minutes: 45 }),
    ]);
    expect(named("Piano Lesson")).toHaveLength(1);
    expect(r.said).toMatch(/already on the calendar/i);
  });

  it("add 8. an event over a Google event is saved; the Google event stays and the overlap is mentioned", async () => {
    const r = await say("Add a study session with Jake tomorrow 3:30-4:30", () => [
      w("create_event", "Add a study session with Jake tomorrow 3:30-4:30", { title: "Study Session with Jake", date: date({ day_offset: 1 }), start_time: "15:30", end_time: "16:30", recurrence: "once" }),
    ]);
    expect(named("Study Session with Jake")).toHaveLength(1);
    expect(r.said).toMatch(/Chemistry Lab Review/);
  });

  it("add 9. late night: 'Add a call at 11:30 tonight for an hour' runs past midnight", async () => {
    await say("Add a call at 11:30 tonight for an hour", () => [
      w("create_event", "Add a call at 11:30 tonight for an hour", { title: "Call", date: date({ day_offset: 0 }), start_time: "23:30", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(when(named("Call")[0])).toBe("2026-11-18 23:30-00:30");
  });

  it("add 10. after daylight saving: 'Add orientation on March 15 at 9am' is 9 AM local time", async () => {
    await say("Add orientation on March 15 at 9am for an hour", () => [
      w("create_event", "Add orientation on March 15 at 9am for an hour", { title: "Orientation", date: date({ iso_date: "2027-03-15" }), start_time: "09:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    const e = named("Orientation")[0];
    expect(e.startsAt).toBe("2027-03-15T16:00:00.000Z");
    expect(when(e)).toBe("2027-03-15 09:00-10:00");
  });

  it("add 11. a task with no due date is priority-first and saved now", async () => {
    await say("Add a task to email coach about the tournament", () => [w("create_task", "Add a task to email coach about the tournament", { title: "Email Coach About Tournament", priority: "medium" })]);
    expect(state.db.tasks.find((t) => t.title === "Email Coach About Tournament")).toMatchObject({ priority: "medium", dueAt: null, status: "todo" });
  });
});

// ---------------------------------------------------------------------------
// Moving and changing
// ---------------------------------------------------------------------------

describe("Moving and changing", () => {
  it("move 1. 'Move the dentist appointment to 5' is done now, Undo puts it back", async () => {
    const r = await say("Move the dentist appointment to 5", (m) => [
      w("update_event", "Move the dentist appointment to 5", { target_ref: m.ref(s.dentist), target_name: "dentist appointment", start_time: "17:00" }),
    ]);
    expect(when(s.dentist)).toBe("2026-11-20 17:00-18:00");
    expect(r.said).toContain("Already done");
    await undoLatest();
    expect(when(s.dentist)).toBe("2026-11-20 16:00-17:00");
  });

  it("move 2. 'Move math tutoring to Friday' moves it; the session it now hits gets a new time on a card", async () => {
    await say("Move math tutoring to Friday", (m) => [
      w("update_event", "Move math tutoring to Friday", { target_ref: m.ref(s.tutoring), target_name: "math tutoring", date: date({ weekday: "fr" }) }),
    ]);
    expect(when(s.tutoring)).toBe("2026-11-20 19:30-20:30");
    expect(pending().map((i) => `${i.action}:${i.title}`)).toEqual(["move_block:History Essay"]);
  });

  it("move 3. 'Move basketball to 6 tomorrow' changes only tomorrow, now", async () => {
    await say("Move basketball to 6 tomorrow", (m) => [
      w("update_event", "Move basketball to 6 tomorrow", { target_ref: m.ref(s.basketball), target_name: "basketball", start_time: "18:00", date: date({ day_offset: 1 }) }),
    ]);
    expect(skipped(s.basketball)).toEqual(["2026-11-19"]);
    expect(s.basketball.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
    const moved = named("Basketball Practice").filter((e) => !e.recurrenceRule);
    expect(moved.map(when)).toEqual(["2026-11-19 18:00-20:00"]);
  });

  it("move 4. 'Move piano to Thursdays from now on' changes the series now", async () => {
    await say("Move piano to Thursdays from now on", (m) => [
      w("update_event", "Move piano to Thursdays from now on", { target_ref: m.ref(s.piano), target_name: "piano", date: date({ weekday: "th" }), scope: "all" }),
    ]);
    expect(ev(s.piano)?.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TH");
  });

  it("move 5. 'Push my chem session an hour later' shifts it by an hour", async () => {
    await say("Push my chem session an hour later", (m) => [
      w("update_event", "Push my chem session an hour later", { target_ref: m.ref(s.chemSession), target_name: "chem session", shift_minutes: 60 }),
    ]);
    expect(when(s.chemSession)).toBe("2026-11-18 20:30-22:00");
  });

  it("move 6. 'Move tutoring 30 minutes earlier' shifts back", async () => {
    await say("Move tutoring 30 minutes earlier", (m) => [
      w("update_event", "Move tutoring 30 minutes earlier", { target_ref: m.ref(s.tutoring), target_name: "tutoring", shift_minutes: -30 }),
    ]);
    expect(when(s.tutoring)).toBe("2026-11-19 19:00-20:00");
  });

  it("move 7. 'Move Debate Club to 1pm, every week' moves the whole Google series now; Undo puts Google back", async () => {
    expectGoogleChange();
    const r = await say("Move Debate Club to 1pm, every week", (m) => [
      w("update_event", "Move Debate Club to 1pm, every week", { target_ref: m.ref(s.debate), target_name: "Debate Club", start_time: "13:00", scope: "all" }),
    ]);
    expect(r.said).toContain("Already done");
    expect(r.said).toMatch(/every week, in Google Calendar too/);
    expect(debateTimes()).toEqual(["13:00-15:00"]);
    await undoLatest();
    expect(debateTimes()).toEqual(["10:00-12:00"]);
    expect(googleSnapshot()).toBe(googleBefore);
  });

  it("move 7b. 'Move debate to 1pm' asks this week or every week; 'just this week' moves only Saturday's, in Google too", async () => {
    expectGoogleChange();
    const t = await say("Move debate to 1pm", (m) => [w("update_event", "Move debate to 1pm", { target_ref: m.ref(s.debate), target_name: "debate", start_time: "13:00" })]);
    expect(t.clarify?.field).toBe("scope");
    expect(google.writes).toEqual([]);
    await say("just this week", (m) => [w("update_event", "just this week", { draft_id: m.action(), scope: "one", explicit: false })]);
    const debates = named("Debate Club").sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));
    const sat = debates.find((e) => when(e).startsWith("2026-11-21"))!;
    expect(when(sat)).toBe("2026-11-21 13:00-15:00");
    expect(debates.filter((e) => e !== sat && Date.parse(e.startsAt!) > NOW.getTime()).every((e) => when(e).endsWith("10:00-12:00"))).toBe(true);
  });

  it("move 7c. 'Move family dinner to 7' (Mom's invite) is refused: only the organizer can move it", async () => {
    const r = await say("Move family dinner to 7", (m) => [
      w("update_event", "Move family dinner to 7", { target_ref: m.ref(s.familyDinner), target_name: "family dinner", start_time: "19:00" }),
    ]);
    expect(when(s.familyDinner)).toBe("2026-11-22 18:00-20:00");
    expect(r.said).toMatch(/invite/);
    expect(applied()).toEqual([]);
  });

  it("move 7d. a view-only shared calendar's event can't be changed, and it says why", async () => {
    const assembly = addGoogle({ title: "School Assembly", day: "2026-11-20", start: "09:00", end: "10:00", calendar: "school" });
    googleBefore = googleSnapshot();
    const r = await say("Move the assembly to 11", (m) => [
      w("update_event", "Move the assembly to 11", { target_ref: m.ref(assembly), target_name: "assembly", start_time: "11:00" }),
    ]);
    expect(when(assembly)).toBe("2026-11-20 09:00-10:00");
    expect(r.said).toMatch(/only view/);
  });

  it("move 7e. without edit permission yet, a Google change asks the user to reconnect", async () => {
    google.canWrite = false;
    for (const e of state.db.events) if (e.externalSource === "google") e.externalAccess = "read";
    const r = await say("Delete the chemistry lab review", (m) => [
      w("remove_event", "Delete the chemistry lab review", { target_ref: m.ref(s.labReview), target_name: "chemistry lab review" }),
    ]);
    expect(ev(s.labReview)).toBeDefined();
    expect(r.said).toMatch(/Reconnect|reconnect/);
  });

  it("move 8. 'Make the SAT practice test 4 hours' changes its length now", async () => {
    await say("Make the SAT practice test 4 hours", (m) => [
      w("update_event", "Make the SAT practice test 4 hours", { target_ref: m.ref(s.satPractice), target_name: "SAT practice test", duration_minutes: 240 }),
    ]);
    expect(when(s.satPractice)).toBe("2026-11-22 09:00-13:00");
  });

  it("move 9. 'Rename robotics meeting to Robotics Build Session' renames now", async () => {
    await say("Rename robotics meeting to Robotics Build Session", (m) => [
      w("update_event", "Rename robotics meeting to Robotics Build Session", { target_ref: m.ref(s.robotics), target_name: "robotics meeting", title: "Robotics Build Session" }),
    ]);
    expect(ev(s.robotics)?.title).toBe("Robotics Build Session");
  });

  it("move 10. two History Essay sessions: asks which, then moves the one picked", async () => {
    const t1 = await say("Move my history essay session to 9pm", (m) => [
      w("update_event", "Move my history essay session to 9pm", { target_ref: m.ref(s.essaySession1), target_name: "history essay session", start_time: "21:00" }),
    ]);
    expect(t1.clarify?.field).toBe("target");
    expect(t1.clarify?.choices.length).toBe(2);
    await say("Thursday", (m) => [w("update_event", "Thursday", { draft_id: m.action(), target_ref: m.ref(s.essaySession1), explicit: false })]);
    expect(when(s.essaySession1)).toBe("2026-11-19 21:00-22:00");
    expect(when(s.essaySession2)).toBe("2026-11-20 19:00-20:30");
  });

  it("move 11. 'Move the dentist to tomorrow at 4:30' moves day and time", async () => {
    await say("Move the dentist to tomorrow at 4:30", (m) => [
      w("update_event", "Move the dentist to tomorrow at 4:30", { target_ref: m.ref(s.dentist), target_name: "dentist", date: date({ day_offset: 1 }), start_time: "16:30" }),
    ]);
    expect(when(s.dentist)).toBe("2026-11-19 16:30-17:30");
  });

  it("move 12. 'Push everything tomorrow back an hour': one-offs (Google's too) and sessions move; repeating events stay, and it says why", async () => {
    expectGoogleChange();
    const r = await say("Push everything tomorrow back an hour", () => [
      w("move_events", "Push everything tomorrow back an hour", { date: date({ day_offset: 1 }), shift_minutes: 60 }),
    ]);
    expect(when(s.robotics)).toBe("2026-11-19 16:30-17:30");
    expect(when(s.tutoring)).toBe("2026-11-19 20:30-21:30");
    expect(when(s.essaySession1)).toBe("2026-11-19 21:45-22:45");
    expect(skipped(s.school)).toEqual([]);
    expect(skipped(s.basketball)).toEqual([]);
    expect(when(s.labReview)).toBe("2026-11-19 16:30-17:30");
    expect(r.said).toMatch(/Chemistry Lab Review.*in Google Calendar too/);
    expect(r.said).toMatch(/School|Basketball Practice/);
  });

  it("move 13. 'Move all my study sessions to the weekend' re-plans sessions onto Sat/Sun", async () => {
    await say("Move all my history essay sessions to Saturday", () => [
      w("move_events", "Move all my history essay sessions to Saturday", { target_name: "history essay sessions", target_date: date({ weekday: "sa" }), window: "this_week" }),
    ]);
    for (const e of [s.essaySession1, s.essaySession2]) expect(when(e).slice(0, 10)).toBe("2026-11-21");
    // Debate Club (Google) and the college essay session keep their times; nothing overlaps them.
    expect(when(s.collegeSession)).toBe("2026-11-21 14:00-16:00");
    const sat = [s.essaySession1, s.essaySession2, s.collegeSession].map((e) => ev(e)!);
    for (const a of sat) for (const b of sat) if (a !== b) expect(Date.parse(a.startsAt!) < Date.parse(b.endsAt!) && Date.parse(b.startsAt!) < Date.parse(a.endsAt!)).toBe(false);
  });

  it("move 14. a task's due date changes now", async () => {
    await say("The history essay is due Tuesday now", (m) => [
      w("update_task", "The history essay is due Tuesday now", { target_ref: m.ref(s.essay), target_name: "history essay", deadline: date({ weekday: "tu" }) }),
    ]);
    expect(task(s.essay)?.dueAt).toBe("2026-11-25T07:59:00.000Z");
  });

  it("move 15. 'make spanish high priority' changes it now", async () => {
    await say("make spanish high priority", (m) => [w("update_task", "make spanish high priority", { target_ref: m.ref(s.spanish), target_name: "spanish", priority: "high" })]);
    expect(task(s.spanish)?.priority).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Cancelling and deleting
// ---------------------------------------------------------------------------

describe("Cancelling and deleting", () => {
  it("cancel 1. 'Cancel my dentist appointment' is done now; Undo brings it back", async () => {
    await say("Cancel my dentist appointment", (m) => [w("remove_event", "Cancel my dentist appointment", { target_ref: m.ref(s.dentist), target_name: "dentist appointment" })]);
    expect(ev(s.dentist)).toBeUndefined();
    await undoLatest();
    expect(when(s.dentist)).toBe("2026-11-20 16:00-17:00");
  });

  it("cancel 2. 'Cancel basketball tomorrow' skips only tomorrow, now", async () => {
    const r = await say("Cancel basketball tomorrow", (m) => [
      w("remove_event", "Cancel basketball tomorrow", { target_ref: m.ref(s.basketball), target_name: "basketball", date: date({ day_offset: 1 }) }),
    ]);
    expect(skipped(s.basketball)).toEqual(["2026-11-19"]);
    expect(ev(s.basketball)).toBeDefined();
    expect(r.said).toContain("Already done");
  });

  it("cancel 3. 'I quit basketball, take it off my calendar' removes the series now", async () => {
    await say("I quit basketball, take it off my calendar", (m) => [
      w("remove_event", "I quit basketball, take it off my calendar", { target_ref: m.ref(s.basketball), target_name: "basketball", scope: "all" }),
    ]);
    expect(ev(s.basketball)).toBeUndefined();
  });

  it("cancel 4. 'Cancel debate this Saturday' removes only Saturday's Debate Club, in Google too; Undo brings it back", async () => {
    expectGoogleChange();
    const count = named("Debate Club").length;
    const r = await say("Cancel debate this Saturday", (m) => [
      w("remove_event", "Cancel debate this Saturday", { target_ref: m.ref(s.debate), target_name: "debate", date: date({ weekday: "sa" }) }),
    ]);
    expect(r.said).toContain("Already done");
    expect(ev(s.debate)).toBeUndefined();
    expect(named("Debate Club")).toHaveLength(count - 1);
    await undoLatest();
    expect(named("Debate Club")).toHaveLength(count);
    expect(googleSnapshot()).toBe(googleBefore);
  });

  it("cancel 5. 'Delete the chemistry lab review' removes it from Google now; Undo restores it", async () => {
    expectGoogleChange();
    const r = await say("Delete the chemistry lab review", (m) => [
      w("remove_event", "Delete the chemistry lab review", { target_ref: m.ref(s.labReview), target_name: "chemistry lab review" }),
    ]);
    expect(ev(s.labReview)).toBeUndefined();
    expect(r.said).toMatch(/in Google Calendar too/);
    await undoLatest();
    expect(named("Chemistry Lab Review").map(when)).toEqual(["2026-11-19 15:30-16:30"]);
    expect(googleSnapshot()).toBe(googleBefore);
  });

  it("cancel 5b. 'I quit debate, delete it from my calendar' removes the whole Google series; Undo restores every week", async () => {
    expectGoogleChange();
    await say("I quit debate, delete it from my calendar", (m) => [
      w("remove_event", "I quit debate, delete it from my calendar", { target_ref: m.ref(s.debate), target_name: "debate", scope: "all" }),
    ]);
    expect(named("Debate Club")).toEqual([]);
    await undoLatest();
    expect(debateTimes()).toEqual(["10:00-12:00"]);
    expect(googleSnapshot()).toBe(googleBefore);
  });

  it("cancel 5c. 'Remove family dinner' (an invite) is allowed: it comes off the user's calendar", async () => {
    expectGoogleChange();
    await say("Remove family dinner from my calendar", (m) => [
      w("remove_event", "Remove family dinner from my calendar", { target_ref: m.ref(s.familyDinner), target_name: "family dinner" }),
    ]);
    expect(ev(s.familyDinner)).toBeUndefined();
  });

  it("cancel 6. 'Delete my Spanish vocab task' deletes it and its session now", async () => {
    await say("Delete my Spanish vocab task", (m) => [w("remove_task", "Delete my Spanish vocab task", { target_ref: m.ref(s.spanish), target_name: "Spanish vocab", title: "Spanish Vocab" })]);
    expect(task(s.spanish)).toBeUndefined();
    expect(ev(s.spanishSession)).toBeUndefined();
  });

  it("cancel 7. 'Cancel the SAT practice test and the dentist' removes both now", async () => {
    await say("Cancel the SAT practice test and the dentist", (m) => [
      w("remove_event", "Cancel the SAT practice test", { target_ref: m.ref(s.satPractice), target_name: "SAT practice test" }),
      w("remove_event", "the dentist", { target_ref: m.ref(s.dentist), target_name: "dentist" }),
    ]);
    expect(ev(s.satPractice)).toBeUndefined();
    expect(ev(s.dentist)).toBeUndefined();
  });

  it("cancel 8. 'Cancel all my study sessions tomorrow' clears tomorrow's sessions only", async () => {
    await say("Cancel all my study sessions tomorrow", () => [w("clear_events", "Cancel all my study sessions tomorrow", { target_name: "study sessions", date: date({ day_offset: 1 }) })]);
    expect(ev(s.essaySession1)).toBeUndefined();
    expect(ev(s.essaySession2)).toBeDefined();
    expect(ev(s.tutoring)).toBeDefined();
  });

  it("cancel 9. 'I'm sick, clear tomorrow': tomorrow is cleared now, Google stays (explained), work moves to other days", async () => {
    const r = await say("I'm sick, clear tomorrow", () => [w("clear_events", "clear tomorrow", { date: date({ day_offset: 1 }) })]);
    expect(skipped(s.school)).toEqual(["2026-11-19"]);
    expect(skipped(s.basketball)).toEqual(["2026-11-19"]);
    expect(ev(s.tutoring)).toBeUndefined();
    expect(ev(s.robotics)).toBeUndefined();
    expect(when(s.essaySession1).slice(0, 10)).not.toBe("2026-11-19");
    expect(ev(s.essaySession1)).toBeDefined();
    expect(r.said).toMatch(/Chemistry Lab Review/);
    expect(r.said).toMatch(/Google Calendar/);
    await undoLatest();
    expect(skipped(s.school)).toEqual([]);
    expect(when(s.tutoring)).toBe("2026-11-19 19:30-20:30");
    expect(when(s.essaySession1)).toBe("2026-11-19 20:45-21:45");
  });

  it("cancel 10. 'never mind' closes the open card", async () => {
    await say("I have a physics test Friday at 10", () => [
      w("create_event", "I have a physics test Friday at 10", { explicit: false, title: "Physics Test", date: date({ weekday: "fr" }), start_time: "10:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(pending().length).toBeGreaterThan(0);
    await say("never mind", (m) => [w("cancel_draft", "never mind", { draft_id: m.action() })]);
    expect(pending()).toEqual([]);
    expect(named("Physics Test")).toHaveLength(0);
  });

  it("cancel 11. 'actually just cancel it' after moving the dentist removes the dentist", async () => {
    await say("Move the dentist appointment to 5", (m) => [w("update_event", "Move the dentist appointment to 5", { target_ref: m.ref(s.dentist), target_name: "dentist appointment", start_time: "17:00" })]);
    await say("actually just cancel it", () => [w("remove_event", "actually just cancel it", { target_name: "it" })]);
    expect(ev(s.dentist)).toBeUndefined();
  });

  it("cancel 12. 'Cancel guitar lesson' (doesn't exist) changes nothing and says so", async () => {
    const r = await say("Cancel guitar lesson", () => [w("remove_event", "Cancel guitar lesson", { target_name: "guitar lesson" })]);
    expect(applied()).toEqual([]);
    expect(pending()).toEqual([]);
    expect(r.said).toMatch(/Nothing called "guitar lesson"/);
  });

  it("cancel 13. 'Skip piano today' skips today's lesson now", async () => {
    await say("Skip piano today", (m) => [w("remove_event", "Skip piano today", { target_ref: m.ref(s.piano), target_name: "piano", date: date({ day_offset: 0 }) })]);
    expect(skipped(s.piano)).toEqual(["2026-11-18"]);
  });

  it("cancel 14. 'Remove all my sessions this week' clears every Whitespace session left this week, nothing else", async () => {
    await say("Remove all my sessions this week", () => [w("clear_events", "Remove all my sessions this week", { target_name: "sessions", window: "this_week" })]);
    for (const x of [s.chemSession, s.essaySession1, s.essaySession2, s.spanishSession, s.collegeSession]) expect(ev(x)).toBeUndefined();
    for (const x of [s.dentist, s.tutoring, s.satPractice, s.robotics]) expect(ev(x)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Checking things off
// ---------------------------------------------------------------------------

describe("Checking things off", () => {
  it("done 1. 'I finished my chem homework' checks it off now and frees tonight's session (as a suggestion)", async () => {
    const r = await say("I finished my chem homework", (m) => [w("complete_task", "I finished my chem homework", { target_ref: m.ref(s.chem), target_name: "chem homework" })]);
    expect(task(s.chem)?.status).toBe("done");
    expect(pending().map((i) => `${i.action}:${i.title}`)).toEqual(["remove_block:Chemistry Homework"]);
    expect(r.said).toContain("Already done");
  });

  it("done 2. 'Spanish and physics are done' checks both off", async () => {
    await say("Spanish and physics are done", (m) => [
      w("complete_task", "Spanish", { target_ref: m.ref(s.spanish), target_name: "Spanish" }),
      w("complete_task", "physics", { target_ref: m.ref(s.physics), target_name: "physics" }),
    ]);
    expect(task(s.spanish)?.status).toBe("done");
    expect(task(s.physics)?.status).toBe("done");
  });

  it("done 3. 'I did everything on my list' checks off every task", async () => {
    await say("I did everything on my list", (m) =>
      [s.chem, s.essay, s.spanish, s.college, s.physics].map((t) => w("complete_task", "I did everything on my list", { target_ref: m.ref(t), target_name: "everything on my list" })),
    );
    expect(state.db.tasks.every((t) => t.status === "done")).toBe(true);
  });

  it("done 4. 'undo that' after a check-off puts the task back", async () => {
    await say("I finished my chem homework", (m) => [w("complete_task", "I finished my chem homework", { target_ref: m.ref(s.chem), target_name: "chem homework" })]);
    const r = await say("wait no, undo that", () => [w("undo", "undo that")]);
    expect(task(s.chem)?.status).toBe("todo");
    expect(r.said).toMatch(/undid|undone|put back/i);
  });

  it("done 5. 'mark training done' (no such task) changes nothing", async () => {
    const r = await say("mark training done", (m) => [w("complete_task", "mark training done", { target_ref: m.ref(s.chem), target_name: "training" })]);
    expect(state.db.tasks.every((t) => t.status === "todo")).toBe(true);
    expect(r.said).toMatch(/Nothing called "training"/);
  });
});

// ---------------------------------------------------------------------------
// Undo in words
// ---------------------------------------------------------------------------

describe("Undo in words", () => {
  it("undo 1. 'undo' after a move puts the event back", async () => {
    await say("Move the dentist appointment to 5", (m) => [w("update_event", "Move the dentist appointment to 5", { target_ref: m.ref(s.dentist), target_name: "dentist appointment", start_time: "17:00" })]);
    await say("undo", () => [w("undo", "undo")]);
    expect(when(s.dentist)).toBe("2026-11-20 16:00-17:00");
  });

  it("undo 2. 'put it back' after a cancel restores it", async () => {
    await say("Cancel my dentist appointment", (m) => [w("remove_event", "Cancel my dentist appointment", { target_ref: m.ref(s.dentist), target_name: "dentist appointment" })]);
    await say("put it back", () => [w("undo", "put it back")]);
    expect(when(s.dentist)).toBe("2026-11-20 16:00-17:00");
  });

  it("undo 3. 'undo' with nothing to undo says so and changes nothing", async () => {
    const r = await say("undo", () => [w("undo", "undo")]);
    expect(r.said).toMatch(/nothing to undo/i);
    expect(applied()).toEqual([]);
  });

  it("undo 4. 'undo' after clearing a day restores the whole day", async () => {
    await say("clear tomorrow", () => [w("clear_events", "clear tomorrow", { date: date({ day_offset: 1 }) })]);
    await say("undo", () => [w("undo", "undo")]);
    expect(skipped(s.school)).toEqual([]);
    expect(when(s.tutoring)).toBe("2026-11-19 19:30-20:30");
    expect(when(s.essaySession1)).toBe("2026-11-19 20:45-21:45");
  });
});

// ---------------------------------------------------------------------------
// Making room
// ---------------------------------------------------------------------------

describe("Making room", () => {
  it("room 1. 'Add dinner with grandma Thursday 7-10pm, make room': saved now, the session in the way moves now, the fixed tutoring is flagged", async () => {
    const r = await say("Add dinner with grandma Thursday 7-10pm, make room", () => [
      w("create_event", "Add dinner with grandma Thursday 7-10pm, make room", { title: "Dinner with Grandma", date: date({ weekday: "th" }), start_time: "19:00", end_time: "22:00", recurrence: "once", make_room: true }),
    ]);
    expect(when(named("Dinner with Grandma")[0])).toBe("2026-11-19 19:00-22:00");
    expect(when(s.essaySession1).slice(0, 10)).not.toBe("2026-11-19");
    expect(ev(s.tutoring)).toBeDefined();
    expect(r.said).toMatch(/Math Tutoring/);
    expect(pending().filter((i) => i.action === "move_block")).toEqual([]);
  });

  it("room 2. 'Tournament Saturday 9-5, clear whatever's in the way': the session moves and Saturday's Debate Club comes off Google, now", async () => {
    expectGoogleChange();
    const r = await say("Basketball tournament Saturday 9am to 5pm, clear whatever's in the way", () => [
      w("create_event", "Basketball tournament Saturday 9am to 5pm, clear whatever's in the way", { title: "Basketball Tournament", date: date({ weekday: "sa" }), start_time: "09:00", end_time: "17:00", recurrence: "once", make_room: true }),
    ]);
    expect(named("Basketball Tournament")).toHaveLength(1);
    expect(when(s.collegeSession).slice(0, 10)).not.toBe("2026-11-21");
    expect(ev(s.debate)).toBeUndefined();
    expect(named("Debate Club").length).toBeGreaterThan(0);
    expect(r.said).toMatch(/Debate Club.*Google Calendar/);
  });

  it("room 3. 'I need 90 minutes Friday for the college essay, make room': lower-priority Spanish moves out of the way, the high-priority essay stays", async () => {
    // Fill Friday so 2 hours don't fit without moving something.
    addEvent({ title: "Volunteering", day: "2026-11-20", start: "20:30", end: "22:30" });
    const r = await say("I need 90 minutes Friday for the college essay, it's urgent, make room", (m) => [
      w("plan_time", "I need 90 minutes Friday for the college essay, it's urgent, make room", {
        target_ref: m.ref(s.college), target_name: "college essay", amount_kind: "single", amount_minutes: 90, date: date({ weekday: "fr" }), priority: "high", make_room: true,
      }),
    ]);
    const placed = pending().filter((i) => i.action === "schedule_block" && i.title.startsWith("College Essay Draft"));
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((i) => fmt(String(i.payload.startsAt)).startsWith("2026-11-20"))).toBe(true);
    expect(when(s.essaySession2)).toBe("2026-11-20 19:00-20:30");
    expect(pending().filter((i) => i.action === "move_block").map((i) => i.title)).toEqual(["Spanish Vocab"]);
    expect(r.said).not.toMatch(/Could not fit/);
  });

  it("room 4. 'make room' when only more important things are in the way is honest about it", async () => {
    const r = await say("I need 3 hours tomorrow for physics, make room", (m) => [
      w("plan_time", "I need 3 hours tomorrow for physics, make room", { target_ref: m.ref(s.physics), target_name: "physics", amount_kind: "total", amount_minutes: 180, window: "tomorrow", make_room: true }),
    ]);
    expect(when(s.essaySession1)).toBe("2026-11-19 20:45-21:45");
    expect(when(s.tutoring)).toBe("2026-11-19 19:30-20:30");
    expect(r.said).toMatch(/Could not fit|higher priority|more important/i);
  });
});

// ---------------------------------------------------------------------------
// Vague references
// ---------------------------------------------------------------------------

describe("Vague references", () => {
  it("vague 1. 'move the chemistry one to 8' asks which (session or Google lab review), changes nothing yet", async () => {
    const r = await say("move the chemistry one to 8", (m) => [
      w("update_event", "move the chemistry one to 8", { target_ref: m.ref(s.chemSession), target_name: "the chemistry one", start_time: "20:00" }),
    ]);
    expect(r.clarify?.field).toBe("target");
    expect(when(s.chemSession)).toBe("2026-11-18 19:30-21:00");
  });

  it("vague 2. 'move it to 8' right after talking about tutoring moves tutoring", async () => {
    history.push({ role: "user", content: "When is math tutoring?" }, { role: "assistant", content: "Math Tutoring is tomorrow at 7:30 PM." });
    await say("move it to 8", (m) => [w("update_event", "move it to 8", { target_ref: m.ref(s.tutoring), target_name: "it", start_time: "20:00" })]);
    expect(when(s.tutoring)).toBe("2026-11-19 20:00-21:00");
  });

  it("vague 3. 'cancel that' right after adding something removes what was just added", async () => {
    await say("Add a study group Saturday 1-3pm", () => [
      w("create_event", "Add a study group Saturday 1-3pm", { title: "Study Group", date: date({ weekday: "sa" }), start_time: "13:00", end_time: "15:00", recurrence: "once" }),
    ]);
    await say("actually cancel that", () => [w("remove_event", "actually cancel that", { target_name: "that" })]);
    expect(named("Study Group")).toHaveLength(0);
  });

  it("vague 4. 'Friday's essay session' picks Friday's one", async () => {
    await say("Move Friday's essay session to 8pm", (m) => [
      w("update_event", "Move Friday's essay session to 8pm", { target_ref: m.ref(s.essaySession2), target_name: "essay session", date: date({ weekday: "fr" }), start_time: "20:00" }),
    ]);
    expect(when(s.essaySession2)).toBe("2026-11-20 20:00-21:30");
    expect(when(s.essaySession1)).toBe("2026-11-19 20:45-21:45");
  });

  it("vague 5. 'cancel tomorrow's stuff after school' clears the afternoon/evening (Google's lab review too), not school", async () => {
    expectGoogleChange();
    await say("cancel tomorrow's stuff after school", () => [w("clear_events", "cancel tomorrow's stuff after school", { date: date({ day_offset: 1 }), start_time: "15:00" })]);
    expect(skipped(s.school)).toEqual([]);
    expect(skipped(s.basketball)).toEqual(["2026-11-19"]);
    expect(ev(s.tutoring)).toBeUndefined();
    expect(ev(s.labReview)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-step messages
// ---------------------------------------------------------------------------

describe("Multi-step messages", () => {
  it("multi 1. 'Skip piano today and move my chem session to 6:30' does both now", async () => {
    await say("Skip piano today and move my chem session to 6:30", (m) => [
      w("remove_event", "Skip piano today", { target_ref: m.ref(s.piano), target_name: "piano", date: date({ day_offset: 0 }) }),
      w("update_event", "move my chem session to 6:30", { target_ref: m.ref(s.chemSession), target_name: "chem session", start_time: "18:30" }),
    ]);
    expect(skipped(s.piano)).toEqual(["2026-11-18"]);
    expect(when(s.chemSession)).toBe("2026-11-18 18:30-20:00");
  });

  it("multi 2. 'Delete the dentist and add an orthodontist appointment Friday at 4 instead' does both now", async () => {
    await say("Delete the dentist and add an orthodontist appointment Friday at 4 instead", (m) => [
      w("remove_event", "Delete the dentist", { target_ref: m.ref(s.dentist), target_name: "dentist" }),
      w("create_event", "add an orthodontist appointment Friday at 4", { title: "Orthodontist Appointment", date: date({ weekday: "fr" }), start_time: "16:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(ev(s.dentist)).toBeUndefined();
    expect(when(named("Orthodontist Appointment")[0])).toBe("2026-11-20 16:00-17:00");
  });

  it("multi 3. 'Add a task to read Hamlet, high priority, and find 2 hours this week for it'", async () => {
    await say("Add a task to read Hamlet, high priority, and find 2 hours this week for it", () => [
      w("create_task", "Add a task to read Hamlet, high priority", { title: "Read Hamlet", priority: "high" }),
      w("plan_time", "find 2 hours this week for it", { title: "Read Hamlet", amount_kind: "total", amount_minutes: 120, window: "this_week" }),
    ]);
    expect(state.db.tasks.find((t) => t.title === "Read Hamlet")?.priority).toBe("high");
    const minutes = pending()
      .filter((i) => i.action === "schedule_block")
      .reduce((n, i) => n + (Date.parse(String(i.payload.endsAt)) - Date.parse(String(i.payload.startsAt))) / 60_000, 0);
    expect(minutes).toBe(120);
  });

  it("multi 4. 'Cancel robotics and debate this week': both are done now, Debate in Google too", async () => {
    expectGoogleChange();
    const r = await say("Cancel robotics and debate this week", (m) => [
      w("remove_event", "Cancel robotics", { target_ref: m.ref(s.robotics), target_name: "robotics" }),
      w("remove_event", "debate this week", { target_ref: m.ref(s.debate), target_name: "debate", date: date({ weekday: "sa" }) }),
    ]);
    expect(ev(s.robotics)).toBeUndefined();
    expect(ev(s.debate)).toBeUndefined();
    expect(inGoogle(named("Debate Club")[0])).toBe(true);
    expect(r.said).toMatch(/Debate Club.*Google Calendar too/);
  });
});

// ---------------------------------------------------------------------------
// Conflicts and duplicates
// ---------------------------------------------------------------------------

describe("Conflicts and duplicates", () => {
  it("conflict 1. a commanded event on top of the dentist is saved and the overlap is named, nothing else changes", async () => {
    const r = await say("Add a call with coach Friday at 4:30 for 30 minutes", () => [
      w("create_event", "Add a call with coach Friday at 4:30 for 30 minutes", { title: "Call with Coach", date: date({ weekday: "fr" }), start_time: "16:30", duration_minutes: 30, recurrence: "once" }),
    ]);
    expect(named("Call with Coach")).toHaveLength(1);
    expect(ev(s.dentist)).toBeDefined();
    expect(r.said).toMatch(/Dentist Appointment/);
  });

  it("conflict 2. 'I have a robotics competition Thursday 3-6' (a statement) proposes skipping practice; nothing changes before Approve", async () => {
    await say("I have a robotics competition Thursday 3-6", () => [
      w("create_event", "I have a robotics competition Thursday 3-6", { explicit: false, title: "Robotics Competition", date: date({ weekday: "th" }), start_time: "15:00", end_time: "18:00", recurrence: "once" }),
    ]);
    expect(named("Robotics Competition")).toHaveLength(0);
    expect(skipped(s.basketball)).toEqual([]);
    expect(pending().map((i) => i.action).sort()).toEqual(["create_event", "skip_occurrence"]);
  });

  it("dup 1. 'remove duplicates, keep the Google one' removes real copies, even with unrelated names, and leaves a partly overlapping event alone", async () => {
    const copy = addEvent({ title: "Debate", day: "2026-09-05", start: "10:00", end: "12:00", rrule: "FREQ=WEEKLY;BYDAY=SA" });
    // xavi's real case: a Whitespace "Debate" and a Google event with a different name in the exact same slot.
    addEvent({ title: "Athena Speech Club", day: "2026-09-02", start: "09:00", end: "11:00", rrule: "FREQ=WEEKLY;BYDAY=WE", google: true });
    googleBefore = googleSnapshot(); // the new Google event must survive too
    const debateWs = addEvent({ title: "Debate", day: "2026-09-02", start: "09:00", end: "11:00", rrule: "FREQ=WEEKLY;BYDAY=WE" });
    // Overlaps the Lab Review but starts later with an unrelated name: a conflict, not a copy.
    const yearbook = addEvent({ title: "Yearbook", day: "2026-11-19", start: "16:00", end: "17:00" });
    await say("remove duplicates, keep the Google one", () => [w("remove_duplicates", "remove duplicates, keep the Google one")]);
    expect(ev(copy)).toBeUndefined();
    expect(ev(debateWs)).toBeUndefined();
    expect(ev(yearbook)).toBeDefined();
  });

  it("dup 2. 'add dentist friday at 4' when it's already there doesn't double it", async () => {
    const r = await say("add dentist friday at 4", () => [
      w("create_event", "add dentist friday at 4", { title: "Dentist Appointment", date: date({ weekday: "fr" }), start_time: "16:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(named("Dentist Appointment")).toHaveLength(1);
    expect(r.said).toMatch(/already on the calendar/i);
  });
});

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

describe("Honesty", () => {
  it("honest 1. a proposal is never described as done", async () => {
    const r = await say("I have a physics test Friday at 10", () => [
      w("create_event", "I have a physics test Friday at 10", { explicit: false, title: "Physics Test", date: date({ weekday: "fr" }), start_time: "10:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    expect(r.said).not.toContain("Already done");
    expect(r.said).toContain("NOT saved");
  });

  it("honest 2. 'yes' approves the waiting card and the reply says the database confirmed it", async () => {
    await say("I have a physics test Friday at 10", () => [
      w("create_event", "I have a physics test Friday at 10", { explicit: false, title: "Physics Test", date: date({ weekday: "fr" }), start_time: "10:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    const r = await say("yes", (m) => [w("confirm_action", "yes", { draft_id: m.action() })]);
    expect(named("Physics Test")).toHaveLength(1);
    expect(r.said).toMatch(/database confirmed/);
  });

  it("honest 3. an approval that hits a changed event reports it wasn't saved", async () => {
    await say("I have a physics test Friday at 10", () => [
      w("create_event", "I have a physics test Friday at 10", { explicit: false, title: "Physics Test", date: date({ weekday: "fr" }), start_time: "10:00", duration_minutes: 60, recurrence: "once" }),
    ]);
    const plan = [...state.db.plans.values()].at(-1)!;
    const res = await approveItems("u1", plan.id, { requestId: "40000000-0000-4000-8000-000000000001", now: NOW });
    expect(res.results.every((x) => x.outcome === "applied")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round two: harder everyday requests
// ---------------------------------------------------------------------------

describe("Round two", () => {
  it("r2 1. 'Move everything tomorrow to Friday': one-offs (Google's too) keep their clock time, sessions find free time Friday", async () => {
    expectGoogleChange();
    const r = await say("Move everything tomorrow to Friday", () => [w("move_events", "Move everything tomorrow to Friday", { date: date({ day_offset: 1 }), target_date: date({ weekday: "fr" }) })]);
    expect(when(s.tutoring)).toBe("2026-11-20 19:30-20:30");
    expect(when(s.robotics)).toBe("2026-11-20 15:30-16:30");
    expect(skipped(s.basketball)).toEqual([]);
    expect(when(s.labReview)).toBe("2026-11-20 15:30-16:30");
    expect(r.said).toMatch(/Chemistry Lab Review/);
  });

  it("r2 2. 'Clear Saturday': Saturday's Debate Club comes off Google, the college essay session moves elsewhere", async () => {
    expectGoogleChange();
    const r = await say("Clear Saturday", () => [w("clear_events", "Clear Saturday", { date: date({ weekday: "sa" }) })]);
    expect(ev(s.collegeSession)).toBeDefined();
    expect(when(s.collegeSession).slice(0, 10)).not.toBe("2026-11-21");
    expect(ev(s.debate)).toBeUndefined();
    expect(r.said).toMatch(/Debate Club/);
  });

  it("r2 3. 'Cancel my study sessions next week' when there are none says so", async () => {
    const r = await say("Cancel my study sessions next week", () => [w("clear_events", "Cancel my study sessions next week", { target_name: "study sessions", window: "next_week" })]);
    expect(applied()).toEqual([]);
    expect(r.said).toMatch(/Nothing on the calendar/);
  });

  it("r2 4. 'Move tomorrow's stuff' with no new time asks when, once", async () => {
    expectGoogleChange();
    const r = await say("Move tomorrow's stuff", () => [w("move_events", "Move tomorrow's stuff", { date: date({ day_offset: 1 }), target_name: "stuff" })]);
    expect(r.clarify?.question).toMatch(/when/i);
    expect(google.writes).toEqual([]);
    await say("an hour later", (m) => [w("move_events", "an hour later", { draft_id: m.action(), shift_minutes: 60, explicit: false })]);
    expect(when(s.tutoring)).toBe("2026-11-19 20:30-21:30");
    expect(when(s.labReview)).toBe("2026-11-19 16:30-17:30");
  });

  it("r2 5. two undos in a row reverse the two newest changes", async () => {
    await say("Cancel my dentist appointment", (m) => [w("remove_event", "Cancel my dentist appointment", { target_ref: m.ref(s.dentist), target_name: "dentist appointment" })]);
    await say("Move tutoring to 8", (m) => [w("update_event", "Move tutoring to 8", { target_ref: m.ref(s.tutoring), target_name: "tutoring", start_time: "20:00" })]);
    await say("undo", () => [w("undo", "undo")]);
    expect(when(s.tutoring)).toBe("2026-11-19 19:30-20:30");
    expect(ev(s.dentist)).toBeUndefined();
    await say("undo that too", () => [w("undo", "undo that too")]);
    expect(when(s.dentist)).toBe("2026-11-20 16:00-17:00");
  });

  it("r2 6. 'Move basketball an hour later' (repeating) asks just this week or every week", async () => {
    const t = await say("Move basketball an hour later", (m) => [w("update_event", "Move basketball an hour later", { target_ref: m.ref(s.basketball), target_name: "basketball", shift_minutes: 60 })]);
    expect(t.clarify?.field).toBe("scope");
    await say("every week", (m) => [w("update_event", "every week", { draft_id: m.action(), scope: "all", explicit: false })]);
    expect(when(s.basketball)).toBe("2026-09-01 18:00-20:00");
    expect(ev(s.basketball)?.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
  });

  it("r2 7. 'Push piano 15 minutes later today' changes today's lesson only", async () => {
    await say("Push piano 15 minutes later today", (m) => [
      w("update_event", "Push piano 15 minutes later today", { target_ref: m.ref(s.piano), target_name: "piano", shift_minutes: 15, date: date({ day_offset: 0 }) }),
    ]);
    expect(skipped(s.piano)).toEqual(["2026-11-18"]);
    expect(named("Piano Lesson").filter((e) => !e.recurrenceRule).map(when)).toEqual(["2026-11-18 18:45-19:30"]);
  });

  it("r2 8. 'Add gym every weekday at 6am for an hour' repeats on weekdays before school", async () => {
    await say("Add gym every weekday at 6am for an hour", () => [w("create_event", "Add gym every weekday at 6am for an hour", { title: "Gym", recurrence: "weekdays", start_time: "06:00", duration_minutes: 60 })]);
    const gym = named("Gym")[0];
    expect(gym.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(when(gym)).toBe("2026-11-19 06:00-07:00");
  });

  it("r2 9. 'Move the dentist to 2pm' (during school) moves it and never proposes skipping School", async () => {
    await say("Move the dentist to 2pm", (m) => [w("update_event", "Move the dentist to 2pm", { target_ref: m.ref(s.dentist), target_name: "dentist", start_time: "14:00" })]);
    expect(when(s.dentist)).toBe("2026-11-20 14:00-15:00");
    expect(pending().filter((i) => i.action === "skip_occurrence")).toEqual([]);
  });

  it("r2 10. 'Add a hackathon Saturday 11 to 2' over Google's Debate Club: saved now; removing that Debate waits for Approve", async () => {
    expectGoogleChange();
    googleSuggestionOk = true;
    const r = await say("Add a hackathon Saturday 11 to 2", () => [
      w("create_event", "Add a hackathon Saturday 11 to 2", { title: "Hackathon", date: date({ weekday: "sa" }), start_time: "11:00", end_time: "14:00", recurrence: "once" }),
    ]);
    expect(named("Hackathon")).toHaveLength(1);
    expect(r.said).toMatch(/Debate Club/);
    expect(r.said).toMatch(/Google Calendar/);
    // Whitespace's own idea: nothing in Google changes before Approve.
    expect(googleSnapshot()).toBe(googleBefore);
    expect(ev(s.debate)).toBeDefined();
    const card = pending().filter((i) => i.action === "remove_event");
    expect(card.map((i) => i.title)).toEqual(["Debate Club"]);
    const plan = [...state.db.plans.values()].at(-1)!;
    await approveItems("u1", plan.id, { itemIds: card.map((i) => i.id), requestId: "40000000-0000-4000-8000-000000000010", now: NOW });
    expect(ev(s.debate)).toBeUndefined();
  });

  it("r2 11. 'I can't make tutoring tomorrow' (a one-time event) proposes cancelling it; nothing changes before Approve", async () => {
    await say("I can't make tutoring tomorrow", (m) => [
      w("cant_make", "I can't make tutoring tomorrow", { explicit: false, target_ref: m.ref(s.tutoring), title: "Math Tutoring", date: date({ day_offset: 1 }) }),
    ]);
    expect(ev(s.tutoring)).toBeDefined();
    expect(pending().map((i) => `${i.action}:${i.title}`)).toContain("remove_event:Math Tutoring");
  });

  it("r2 12. 'Mark chem done and delete spanish' does both now", async () => {
    await say("Mark chem done and delete spanish", (m) => [
      w("complete_task", "Mark chem done", { target_ref: m.ref(s.chem), target_name: "chem" }),
      w("remove_task", "delete spanish", { target_ref: m.ref(s.spanish), target_name: "spanish", title: "Spanish Vocab" }),
    ]);
    expect(task(s.chem)?.status).toBe("done");
    expect(task(s.spanish)).toBeUndefined();
    expect(ev(s.spanishSession)).toBeUndefined();
  });

  it("r2 13. 'Add soccer Mondays and Wednesdays 4-6, and skip piano this week' does both", async () => {
    await say("Add soccer Mondays and Wednesdays 4-6, and skip piano this week", (m) => [
      w("create_event", "Add soccer Mondays and Wednesdays 4-6", { title: "Soccer Practice", recurrence: "weekly", days: ["mo", "we"], start_time: "16:00", end_time: "18:00" }),
      w("remove_event", "skip piano this week", { target_ref: m.ref(s.piano), target_name: "piano", scope: "one" }),
    ]);
    expect(named("Soccer Practice")[0]?.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(skipped(s.piano)).toEqual(["2026-11-18"]);
  });

  it("r2 14. 'Move tutoring to 6 tomorrow' (already tomorrow) only changes the time", async () => {
    await say("Move tutoring to 6 tomorrow", (m) => [w("update_event", "Move tutoring to 6 tomorrow", { target_ref: m.ref(s.tutoring), target_name: "tutoring", start_time: "18:00", date: date({ day_offset: 1 }) })]);
    expect(when(s.tutoring)).toBe("2026-11-19 18:00-19:00");
  });

  it("r2 15. 'Push my history essay sessions back 30 minutes this week' shifts both", async () => {
    await say("Push my history essay sessions back 30 minutes this week", () => [
      w("move_events", "Push my history essay sessions back 30 minutes this week", { target_name: "history essay sessions", window: "this_week", shift_minutes: 30 }),
    ]);
    expect(when(s.essaySession1)).toBe("2026-11-19 21:15-22:15");
    expect(when(s.essaySession2)).toBe("2026-11-20 19:30-21:00");
    expect(when(s.collegeSession)).toBe("2026-11-21 14:00-16:00");
  });

  it("r2 16. 'Delete the robotics meeting' then 'never mind, put it back' restores it", async () => {
    await say("Delete the robotics meeting", (m) => [w("remove_event", "Delete the robotics meeting", { target_ref: m.ref(s.robotics), target_name: "robotics meeting" })]);
    expect(ev(s.robotics)).toBeUndefined();
    await say("never mind, put it back", () => [w("undo", "put it back")]);
    expect(when(s.robotics)).toBe("2026-11-19 15:30-16:30");
  });

  it("r2 17. 'Cancel tutoring' resolves the one-word name to Math Tutoring without a question", async () => {
    const r = await say("Cancel tutoring", (m) => [w("remove_event", "Cancel tutoring", { target_ref: m.ref(s.tutoring), target_name: "tutoring" })]);
    expect(r.clarify).toBeNull();
    expect(ev(s.tutoring)).toBeUndefined();
  });

  it("r2 18. 'clear this week' clears Google's own events too, leaves the shared Family Dinner, and leaves nothing pending", async () => {
    expectGoogleChange();
    await say("clear this week", () => [w("clear_events", "clear this week", { window: "this_week", target_name: "everything" })]);
    expect(ev(s.dentist)).toBeUndefined();
    expect(skipped(s.basketball)).toEqual(["2026-11-19"]);
    expect(ev(s.labReview)).toBeUndefined();
    expect(ev(s.debate)).toBeUndefined();
    expect(ev(s.familyDinner)).toBeDefined();
    expect(pending()).toEqual([]);
  });
});
