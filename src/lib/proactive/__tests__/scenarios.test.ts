import { describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/assistant/build-plan";
import { event, NOW, PREFS, task, TZ, uuid, weekCalendar, world } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Task } from "@/lib/domain/types";
import { checkPlacements } from "@/lib/scheduling/planner";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import type { Recommendation, RecommendationAction } from "@/features/proactive/types";
import { analyze, type ProactiveInput } from "../analyze";
import { buildBrief } from "../brief";
import { detect, type Candidate } from "../detect";
import { reconcile, type StoredRecommendation } from "../reconcile";
import { specsForAction } from "../specs";
import { isQuietTime, surface } from "../surface";

// The engine must never need the AI. If anything here reached for it, these would throw.
vi.mock("@/lib/ai/service", () => ({
  interpretMessage: () => {
    throw new Error("AI unavailable");
  },
}));

/** NOW = Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. School 8-3 weekdays, volleyball Thu 6-8 PM. */
const due = (date: string, time = "23:59", tz = TZ) => zonedToUtc(date, time, tz).toISOString();

function input(over: Partial<ProactiveInput> = {}): ProactiveInput {
  return { now: NOW.toISOString(), timeZone: TZ, events: weekCalendar(), tasks: [], preferences: PREFS, ...over };
}

/** A work session Whitespace scheduled from an approved plan. */
function session(t: Task, date: string, start: string, end: string): Commitment {
  return event({ title: t.title, date, start, end, kind: "flexible", planItemId: uuid(), taskId: t.id });
}

const byKind = (cs: Candidate[], kind: Candidate["kind"]) => cs.filter((c) => c.kind === kind);

/** Runs an action the way the service does: specs -> buildPlan, nothing explicit. */
function propose(action: RecommendationAction, data: ProactiveInput, busy: { start: string; end: string; title?: string }[] = []) {
  const spec = specsForAction(action, {
    todayKey: "2026-11-18",
    timeZone: data.timeZone,
    tasks: new Map(data.tasks.map((t) => [t.id, t])),
    events: new Map(data.events.map((e) => [e.id, e])),
    maxSessionMinutes: data.preferences.maxSessionMinutes,
    nowMs: Date.parse(data.now),
  });
  if (!spec.ok || spec.prompt !== null) throw new Error(spec.ok ? "prompt" : spec.error);
  return buildPlan({
    now: data.now,
    world: world(),
    preferences: data.preferences,
    events: data.events,
    openTasks: data.tasks,
    busy,
    specs: spec.specs.map((s) => ({ spec: s, explicit: false })),
    sourceMessageId: null,
  });
}

function stored(c: Candidate, over: Partial<StoredRecommendation> = {}): StoredRecommendation {
  return {
    id: uuid(),
    dedupeKey: c.dedupeKey,
    status: "open",
    taskId: c.taskId,
    planId: null,
    snoozedUntil: null,
    updatedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    priority: c.priority,
    title: c.title,
    reason: c.reason,
    message: c.message,
    facts: c.facts,
    actions: c.actions,
    commitmentIds: c.commitmentIds,
    date: c.date,
    ...over,
  };
}

describe("1. one assignment due tomorrow", () => {
  const history = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
  const data = input({ tasks: [history] });

  it("recommends starting it, with the real numbers", () => {
    const cs = detect(data);
    expect(cs).toHaveLength(1);
    const c = cs[0];
    expect(c.kind).toBe("deadline_soon");
    expect(c.title).toBe("History essay is due tomorrow");
    expect(c.message).toContain("I'd start this afternoon");
    expect(c.facts).toContain("About 2 h of work left");
    expect(c.actions[0]).toMatchObject({ kind: "schedule_work", params: { taskId: history.id, minutes: 120 } });
  });

  it("the daily brief mentions it and offers to organize the day", () => {
    const brief = buildBrief(analyze(data));
    expect(brief.focus.map((f) => f.title)).toEqual(["History essay"]);
    expect(brief.message).toContain("“History essay” is due tomorrow");
    expect(brief.message).toContain("Want me to organize your schedule?");
    expect(brief.action).toMatchObject({ kind: "plan_day", params: { date: "2026-11-18", taskIds: [history.id] } });
  });

  it("the plan it proposes is pending sessions before the deadline", () => {
    const plan = propose(detect(data)[0].actions[0], data);
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) {
      expect(item.action).toBe("schedule_block");
      expect(item.autoApply).toBe(false);
      expect(Date.parse(String(item.payload.endsAt))).toBeLessThanOrEqual(Date.parse(history.dueAt!));
    }
  });
});

describe("2. several approaching deadlines", () => {
  it("gives each task one recommendation, without calling the week overloaded", () => {
    const tasks = [
      task({ title: "Math worksheet", dueAt: due("2026-11-19"), estimatedMinutes: 45 }),
      task({ title: "Lab report", dueAt: due("2026-11-23"), estimatedMinutes: 150 }),
      task({ title: "Spanish vocab", dueAt: due("2026-11-20"), estimatedMinutes: 30 }),
    ];
    const cs = detect(input({ tasks }));
    expect(byKind(cs, "deadline_soon").map((c) => c.taskId)).toEqual([tasks[0].id]);
    expect(byKind(cs, "start_early").map((c) => c.taskId)).toEqual([tasks[1].id]);
    expect(byKind(cs, "start_early")[0].actions[0]).toMatchObject({ kind: "split_sessions", params: { sessions: 3, minutesEach: 50 } });
    expect(byKind(cs, "overload_week")).toHaveLength(0);
    expect(new Set(cs.map((c) => c.dedupeKey)).size).toBe(cs.length);
  });
});

describe("3. more work than available time", () => {
  const tasks = [
    task({ title: "Research paper", dueAt: due("2026-11-20"), estimatedMinutes: 600, priority: "high" }),
    task({ title: "Chem problem set", dueAt: due("2026-11-20"), estimatedMinutes: 400 }),
  ];
  const cs = detect(input({ tasks }));

  it("flags the deadline at risk with honest numbers", () => {
    const risk = byKind(cs, "deadline_at_risk");
    expect(risk.map((c) => c.taskId)).toContain(tasks[0].id);
    expect(risk[0].priority).toBe("high");
    expect(risk[0].reason).toMatch(/needs about 10 h more, but only about \d+ h( \d+ min)? of realistic free time/);
  });

  it("flags the overloaded day and week", () => {
    const day = byKind(cs, "overload_day").find((c) => c.date === "2026-11-20");
    expect(day?.title).toBe("Friday looks overloaded");
    expect(day?.message).toMatch(/^Friday is looking pretty busy: 2 deadlines/);
    const week = byKind(cs, "overload_week");
    expect(week).toHaveLength(1);
    expect(week[0].actions[0].kind).toBe("plan_week");
  });

  it("planning the week reports the shortfall instead of overbooking", () => {
    const data = input({ tasks });
    const plan = propose(byKind(cs, "overload_week")[0].actions[0], data);
    expect(plan.unscheduled.length).toBeGreaterThan(0);
    const check = checkPlacements(
      { now: data.now, timeZone: TZ, window: { start: data.now, end: due("2026-11-30") }, events: data.events, preferences: PREFS },
      plan.items.map((i) => ({ id: i.title, start: String(i.payload.startsAt), end: String(i.payload.endsAt) })),
    );
    expect(check.ok).toBe(true);
  });
});

describe("4. a task postponed several times", () => {
  it("suggests breaking it up or lowering its priority", () => {
    const essay = task({ title: "College essay draft", dueAt: due("2026-11-27"), estimatedMinutes: 180, postponeCount: 3 });
    const [c] = detect(input({ tasks: [essay] }));
    expect(c.kind).toBe("postponed");
    expect(c.message).toContain("pushed “College essay draft” back 3 times");
    expect(c.actions.map((a) => a.kind)).toEqual(["split_sessions", "change_priority", "mark_complete"]);
    expect(c.dedupeKey).toBe(`postponed:${essay.id}:2`);
    // Pushed back again later: a new situation.
    const [again] = detect(input({ tasks: [{ ...essay, postponeCount: 5 }] }));
    expect(again.dedupeKey).toBe(`postponed:${essay.id}:4+`);
  });

  it("doesn't fire for one postponement", () => {
    const t = task({ title: "Read ch. 4", dueAt: due("2026-11-27"), estimatedMinutes: 60, postponeCount: 1 });
    expect(detect(input({ tasks: [t] }))).toHaveLength(0);
  });
});

describe("5. unavailable during a scheduled study session", () => {
  const bio = task({ title: "Biology study", dueAt: due("2026-11-21"), estimatedMinutes: 60 });
  const block = session(bio, "2026-11-19", "16:00", "17:00");
  const dentist = event({ title: "Dentist", date: "2026-11-19", start: "15:45", end: "17:30" });
  const data = input({ tasks: [bio], events: [...weekCalendar(), block, dentist] });

  it("recognizes the plan no longer works", () => {
    const broken = byKind(detect(data), "plan_broken");
    expect(broken).toHaveLength(1);
    expect(broken[0].message).toBe("Your Biology study session tomorrow at 4 PM now overlaps Dentist. Want me to find another time before it's due Saturday?");
    expect(broken[0].actions[0]).toMatchObject({ kind: "reschedule", params: { commitmentIds: [block.id] } });
  });

  it("proposes a move to a free slot, for approval, without conflicts", () => {
    const plan = propose(byKind(detect(data), "plan_broken")[0].actions[0], data);
    expect(plan.kind).toBe("reschedule");
    expect(plan.items).toHaveLength(1);
    const move = plan.items[0];
    expect(move.action).toBe("move_block");
    expect(move.autoApply).toBe(false);
    const check = checkPlacements(
      { now: data.now, timeZone: TZ, window: { start: data.now, end: due("2026-11-22") }, events: data.events.filter((e) => e.id !== block.id), preferences: PREFS },
      [{ id: "m", start: String(move.payload.startsAt), end: String(move.payload.endsAt) }],
    );
    expect(check.ok).toBe(true);
  });

  it("a session that was missed (time passed, task open) asks what happened", () => {
    const past = session(bio, "2026-11-17", "16:00", "17:00");
    const [c] = detect(input({ tasks: [{ ...bio, dueAt: due("2026-11-28") }], events: [...weekCalendar(), past] }));
    expect(c.kind).toBe("missed_session");
    expect(c.actions.map((a) => a.kind)).toEqual(["schedule_work", "mark_complete"]);
  });
});

describe("brief wording", () => {
  it("an event in progress reads as 'until' its end", () => {
    const now = zonedToUtc("2026-11-18", "09:15", TZ).toISOString();
    const t = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
    expect(buildBrief(analyze(input({ now, tasks: [t] }))).message).toMatch(/^You have School until 3 PM today, and “History essay” is due tomorrow\./);
  });
});

describe("6. no tasks or commitments", () => {
  it("finds nothing and says so plainly", () => {
    const data = input({ events: [] });
    expect(detect(data)).toEqual([]);
    const brief = buildBrief(analyze(data));
    expect(brief.action).toBeNull();
    expect(brief.focus).toEqual([]);
    expect(brief.message).toBe("Nothing else is on your calendar today, and no deadlines need attention.");
  });
});

describe("7-9. dismiss, reject, approve", () => {
  const t = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
  const [c] = detect(input({ tasks: [t] }));
  const later = new Date(NOW.getTime() + 3 * 3_600_000);

  it("a new situation is inserted once", () => {
    const first = reconcile({ stored: [], candidates: [c], plans: new Map(), now: NOW });
    expect(first.inserts).toEqual([c]);
    const second = reconcile({ stored: [stored(c)], candidates: [c], plans: new Map(), now: later });
    expect(second).toEqual({ inserts: [], updates: [] });
  });

  it("7. dismissed stays dismissed, and the task isn't nagged about through other kinds", () => {
    const row = stored(c, { status: "dismissed" });
    expect(reconcile({ stored: [row], candidates: [c], plans: new Map(), now: later })).toEqual({ inserts: [], updates: [] });
    const other: Candidate = { ...c, kind: "postponed", dedupeKey: `postponed:${t.id}:2`, priority: "medium" };
    expect(reconcile({ stored: [row], candidates: [other], plans: new Map(), now: later }).inserts).toEqual([]);
    // High priority still gets through.
    expect(reconcile({ stored: [row], candidates: [{ ...other, priority: "high" }], plans: new Map(), now: later }).inserts).toHaveLength(1);
  });

  it("'not now' comes back after the snooze, only if still true", () => {
    const row = stored(c, { status: "snoozed", snoozedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() });
    expect(reconcile({ stored: [row], candidates: [c], plans: new Map(), now: NOW }).updates).toEqual([]);
    expect(reconcile({ stored: [row], candidates: [c], plans: new Map(), now: later }).updates[0].patch.status).toBe("open");
    expect(reconcile({ stored: [row], candidates: [], plans: new Map(), now: later }).updates[0].patch.status).toBe("resolved");
  });

  it("8. a rejected plan dismisses the recommendation", () => {
    const planId = uuid();
    const row = stored(c, { status: "proposed", planId });
    const r = reconcile({ stored: [row], candidates: [c], plans: new Map([[planId, "rejected"]]), now: later });
    expect(r.inserts).toEqual([]);
    expect(r.updates).toEqual([{ id: row.id, patch: { status: "dismissed", lastSeenAt: later.toISOString() } }]);
  });

  it("9. an approved plan marks it acted; a pending one waits; an expired one reopens", () => {
    const planId = uuid();
    const row = stored(c, { status: "proposed", planId });
    const acted = reconcile({ stored: [row], candidates: [], plans: new Map([[planId, "applied"]]), now: later });
    expect(acted.updates[0].patch.status).toBe("acted");
    expect(reconcile({ stored: [row], candidates: [c], plans: new Map([[planId, "pending"]]), now: later }).updates).toEqual([]);
    expect(reconcile({ stored: [row], candidates: [c], plans: new Map([[planId, "expired"]]), now: later }).updates[0].patch.status).toBe("open");
  });

  it("a situation that goes away resolves the open recommendation", () => {
    const r = reconcile({ stored: [stored(c)], candidates: [], plans: new Map(), now: later });
    expect(r.updates[0].patch).toMatchObject({ status: "resolved" });
  });
});

describe("10. two recommendations that would otherwise book the same time", () => {
  it("the second plan avoids the time the first plan is still offering", () => {
    const a = task({ title: "Math worksheet", dueAt: due("2026-11-19"), estimatedMinutes: 90 });
    const b = task({ title: "English reading", dueAt: due("2026-11-19"), estimatedMinutes: 90 });
    const data = input({ tasks: [a, b] });
    const cs = detect(data);
    const first = propose(cs.find((c) => c.taskId === a.id)!.actions[0], data);
    const busy = first.items.map((i) => ({ start: String(i.payload.startsAt), end: String(i.payload.endsAt), title: i.title }));
    const second = propose(cs.find((c) => c.taskId === b.id)!.actions[0], data, busy);
    const all = [...first.items, ...second.items].map((i, n) => ({ id: String(n), start: String(i.payload.startsAt), end: String(i.payload.endsAt) }));
    expect(second.items.length).toBeGreaterThan(0);
    const check = checkPlacements({ now: data.now, timeZone: TZ, window: { start: data.now, end: due("2026-11-20") }, events: data.events, preferences: PREFS }, all);
    expect(check.results.every((r) => !r.conflicts.some((x) => x.kind === "placement"))).toBe(true);
  });
});

describe("11. AI unavailable", () => {
  it("detection, the brief and plan building are fully deterministic", () => {
    const t = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
    const data = input({ tasks: [t] });
    const once = detect(data);
    expect(detect(data)).toEqual(once);
    expect(once[0].message.length).toBeGreaterThan(20);
    expect(buildBrief(analyze(data)).message).toContain("History essay");
    expect(propose(once[0].actions[0], data).items.length).toBeGreaterThan(0);
  });
});

describe("12. time zone differs from UTC", () => {
  it("uses the user's local day for 'today', due dates and keys", () => {
    const tokyo = "Asia/Tokyo";
    // 8 AM Thursday Nov 19 in Tokyo = 11 PM Wednesday Nov 18 in UTC.
    const now = zonedToUtc("2026-11-19", "08:00", tokyo).toISOString();
    expect(now.slice(0, 10)).toBe("2026-11-18");
    const t = task({ title: "Kanji quiz prep", dueAt: due("2026-11-19", "23:59", tokyo), estimatedMinutes: 60 });
    const [c] = detect({ now, timeZone: tokyo, events: [], tasks: [t], preferences: PREFS });
    expect(c.title).toBe("Kanji quiz prep is due today");
    expect(c.dedupeKey).toBe(`deadline_soon:${t.id}:2026-11-19`);
    expect(c.priority).toBe("high");
  });

  it("an evening in Los Angeles is already tomorrow in UTC", () => {
    const now = zonedToUtc("2026-11-18", "20:00", TZ).toISOString();
    expect(now.slice(0, 10)).toBe("2026-11-19");
    const t = task({ title: "Physics lab", dueAt: due("2026-11-19"), estimatedMinutes: 60 });
    const [c] = detect(input({ now, tasks: [t] }));
    expect(c.title).toBe("Physics lab is due tomorrow");
  });
});

describe("no calendar changes without approval", () => {
  it("detectors never mutate their input, and every proposed item waits for approval", () => {
    const tasks = [
      task({ title: "Research paper", dueAt: due("2026-11-20"), estimatedMinutes: 600, priority: "high" }),
      task({ title: "Late lab", dueAt: due("2026-11-16"), estimatedMinutes: 60 }),
      task({ title: "Essay", dueAt: due("2026-11-27"), estimatedMinutes: 180, postponeCount: 2 }),
    ];
    const bio = task({ title: "Biology study", dueAt: due("2026-11-21"), estimatedMinutes: 60 });
    const events = [...weekCalendar(), session(bio, "2026-11-19", "16:00", "17:00"), event({ title: "Dentist", date: "2026-11-19", start: "16:00", end: "17:00" })];
    const data = input({ tasks: [...tasks, bio], events });
    const snapshot = JSON.stringify(data);
    const cs = detect(data);
    buildBrief(analyze(data));
    expect(JSON.stringify(data)).toBe(snapshot);
    const planned = cs.flatMap((c) => c.actions).filter((a) => a.kind !== "ask");
    expect(planned.length).toBeGreaterThan(4);
    for (const action of planned) {
      for (const item of propose(action, data).items) expect(item.autoApply).toBe(false);
    }
  });
});

describe("overdue and deprioritized tasks", () => {
  it("raises an important overdue task, softens one the user already touched", () => {
    const late = task({ title: "Late lab", dueAt: due("2026-11-16"), estimatedMinutes: 60, priority: "high" });
    const [c] = detect(input({ tasks: [late] }));
    expect(c).toMatchObject({ kind: "overdue", priority: "high", title: "Late lab is overdue" });
    expect(c.actions.map((a) => a.kind)).toEqual(["schedule_work", "mark_complete", "ask", "change_priority"]);
    const touched = { ...late, priority: "medium" as const, updatedAt: due("2026-11-17", "12:00") };
    expect(detect(input({ tasks: [touched] }))[0].priority).toBe("low");
  });

  it("finishing time for an overdue task lands in the next few days, due date untouched", () => {
    const late = task({ title: "Late lab", dueAt: due("2026-11-16"), estimatedMinutes: 60 });
    const data = input({ tasks: [late] });
    const plan = propose(detect(data)[0].actions[0], data);
    expect(plan.items[0].action).toBe("schedule_block");
    expect(plan.items.every((i) => i.action !== "update_task")).toBe(true);
  });
});

describe("frequency controls", () => {
  const rec = (over: Partial<Recommendation>): Recommendation => ({
    id: uuid(),
    kind: "deadline_soon",
    priority: "medium",
    status: "open",
    title: "t",
    reason: "r",
    message: "m",
    facts: [],
    target: { taskId: null, commitmentIds: [], date: null },
    actions: [],
    dedupeKey: uuid(),
    planId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastShownAt: null,
    raisedRecently: false,
    ...over,
  });
  const recs = [
    rec({ priority: "low", kind: "start_early" }),
    rec({ priority: "medium", kind: "overload_day" }),
    rec({ priority: "high", kind: "overdue" }),
    rec({ priority: "high", kind: "plan_broken", raisedRecently: true }),
    rec({ priority: "medium", status: "dismissed" }),
  ];
  const opts = (proactivity: "minimal" | "balanced" | "proactive", quiet: [string, string] | null = null) => ({
    settings: { proactivity, quietHoursStart: quiet?.[0] ?? null, quietHoursEnd: quiet?.[1] ?? null },
    now: NOW,
    timeZone: TZ,
    mode: "home" as const,
  });

  it("limits by level, fresh first", () => {
    expect(surface(recs, opts("minimal")).map((r) => r.kind)).toEqual(["overdue"]);
    expect(surface(recs, opts("balanced")).map((r) => r.kind)).toEqual(["overdue", "overload_day"]);
    expect(surface(recs, opts("proactive")).map((r) => r.kind)).toEqual(["overdue", "overload_day", "start_early"]);
    expect(surface(recs, { ...opts("minimal"), mode: "all" })).toHaveLength(4);
  });

  it("stays quiet during quiet hours, across midnight, in the user's zone", () => {
    // NOW is 4 PM in Los Angeles (midnight UTC).
    expect(isQuietTime(NOW, TZ, opts("balanced", ["15:00", "17:00"]).settings)).toBe(true);
    expect(isQuietTime(NOW, TZ, opts("balanced", ["22:00", "07:00"]).settings)).toBe(false);
    expect(isQuietTime(zonedToUtc("2026-11-18", "23:30", TZ), TZ, opts("balanced", ["22:00", "07:00"]).settings)).toBe(true);
    expect(isQuietTime(zonedToUtc("2026-11-19", "06:59", TZ), TZ, opts("balanced", ["22:00", "07:00"]).settings)).toBe(true);
    expect(surface(recs, opts("proactive", ["15:00", "17:00"]))).toEqual([]);
  });
});
