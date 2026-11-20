import { describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/assistant/build-plan";
import type { ActionSpec } from "@/lib/assistant/assess";
import { event, NOW, PREFS, task, TZ, uuid, weekCalendar, world } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Task } from "@/lib/domain/types";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import type { RecommendationAction } from "@/features/proactive/types";
import { analyze, type ProactiveInput } from "../analyze";
import { buildBrief, planDayPicks } from "../brief";
import { examPreps } from "../detect";
import { examPrepPlan, hasPrep, subjectWords } from "../exam";
import { realityCheck } from "../reality";
import { specsForAction } from "../specs";

vi.mock("@/lib/ai/service", () => ({
  interpretMessage: () => {
    throw new Error("AI unavailable");
  },
}));

/** NOW = Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. Work 3:30-10 PM weekdays, 3 h daily limit, 30% kept free. */
const due = (date: string, time = "23:59") => zonedToUtc(date, time, TZ).toISOString();

function input(over: Partial<ProactiveInput> = {}): ProactiveInput {
  return { now: NOW.toISOString(), timeZone: TZ, events: weekCalendar(), tasks: [], preferences: PREFS, ...over };
}

function specs(action: RecommendationAction, data: ProactiveInput) {
  return specsForAction(action, {
    todayKey: "2026-11-18",
    timeZone: data.timeZone,
    tasks: new Map(data.tasks.map((t) => [t.id, t])),
    events: new Map(data.events.map((e) => [e.id, e])),
    maxSessionMinutes: data.preferences.maxSessionMinutes,
    nowMs: Date.parse(data.now),
  });
}

function build(list: ActionSpec[], data: { events?: Commitment[]; tasks?: Task[] } = {}, explicit = true) {
  return buildPlan({
    now: NOW.toISOString(),
    world: world(),
    preferences: PREFS,
    events: data.events ?? weekCalendar(),
    openTasks: data.tasks ?? [],
    busy: [],
    specs: list.map((spec) => ({ spec, explicit })),
    sourceMessageId: null,
  });
}

describe("plan my day v2", () => {
  const a = task({ title: "Math worksheet", dueAt: due("2026-11-19"), estimatedMinutes: 60 });
  const b = task({ title: "Lab report", dueAt: due("2026-11-20"), estimatedMinutes: 90, priority: "high" });
  const c = task({ title: "History essay", dueAt: due("2026-11-23"), estimatedMinutes: 120 });
  const d = task({ title: "College list", priority: "high" });

  it("fills the day's real capacity in ranking order, not just three tasks", () => {
    const plan = planDayPicks(analyze(input({ tasks: [a, b, c, d] })), "2026-11-18");
    expect(plan.capacity).toBe(180);
    // 60 + 90 fill most of the day; the essay is multi-session work, so the last 30 min go to it.
    expect(plan.picks).toEqual([
      { taskId: a.id, minutes: 60 },
      { taskId: b.id, minutes: 90 },
      { taskId: c.id, minutes: 30 },
    ]);
    expect(plan.leftOut).toEqual([{ taskId: d.id, reason: "No time estimate yet, so I couldn't size it." }]);
  });

  it("explains what didn't make it, and why that's fine or not", () => {
    const e = task({ title: "Spanish vocab", dueAt: due("2026-11-20"), estimatedMinutes: 60 });
    const plan = planDayPicks(analyze(input({ tasks: [a, b, e] })), "2026-11-18");
    expect(plan.picks.map((p) => p.taskId)).toEqual([a.id, b.id]);
    expect(plan.leftOut).toEqual([{ taskId: e.id, reason: "No room left today. Due Friday, and there's time before then." }]);
  });

  it("the brief's Plan my day carries the picks, and the card lists what was left for later", () => {
    const data = input({ tasks: [a, b, c, d] });
    const brief = buildBrief(analyze(data));
    expect(brief.action).toMatchObject({ kind: "plan_day", params: { date: "2026-11-18", taskIds: [a.id, b.id, c.id], minutes: ["60", "90", "30"] } });
    const spec = specs(brief.action!, data);
    if (!spec.ok || spec.prompt !== null) throw new Error("no specs");
    expect(spec.specs).toHaveLength(3);
    expect(spec.specs.map((s) => (s.kind === "plan_time" && s.amount.type === "total" ? s.amount.minutes : null))).toEqual([60, 90, 30]);
    expect(spec.leftOut).toEqual([{ title: "College list", minutes: 0, reason: "No time estimate yet, so I couldn't size it." }]);
  });

  it("older plan_day actions with only task ids still work", () => {
    const data = input({ tasks: [a] });
    const spec = specs({ id: "plan_day", kind: "plan_day", label: "Plan my day", params: { date: "2026-11-18", taskIds: [a.id] } }, data);
    expect(spec.ok && spec.specs.length).toBe(1);
  });
});

describe("reality check on a new task", () => {
  const newTask = (over: Partial<Extract<ActionSpec, { kind: "task_create" }>> = {}): ActionSpec => ({
    kind: "task_create",
    title: "Physics project",
    lifeAreaId: null,
    dueDate: "2026-11-20",
    dueTime: null,
    estimatedMinutes: 120,
    priority: "medium",
    description: null,
    ...over,
  });

  it("when it fits, the task is created and its sessions are proposed on the same card", () => {
    const plan = build([newTask()]);
    expect(plan.items[0]).toMatchObject({ action: "create_task", autoApply: true });
    expect(plan.items[0].display.warnings).toEqual([]);
    const sessions = plan.items.filter((i) => i.action === "schedule_block");
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.autoApply === false && s.payload.forNewTask === true && s.payload.taskId === null)).toBe(true);
    expect(sessions.reduce((m, s) => m + s.display.timing!.durationMinutes, 0)).toBe(120);
    expect(sessions.every((s) => s.display.timing!.end <= due("2026-11-20"))).toBe(true);
    expect(plan.notes.some((n) => n.includes("it fits"))).toBe(true);
  });

  it("when it doesn't fit, says so and recommends one concrete fix", () => {
    const other = task({ title: "Book report", dueAt: due("2026-11-19"), estimatedMinutes: 150, priority: "low" });
    const plan = build([newTask({ dueDate: "2026-11-19", estimatedMinutes: 240, priority: "high" })], { tasks: [other] });
    expect(plan.items[0].display.warnings[0]).toMatch(/^Doesn't fit: it needs about 4 h/);
    const note = plan.notes.find((n) => n.includes("doesn't fit"))!;
    expect(note).toContain("moving “Book report” (low priority) later");
  });

  it("flags a tight fit", () => {
    const a = analyze(input());
    const dueMs = Date.parse(due("2026-11-19"));
    const free = realityCheck(a, { title: "X", dueMs, minutes: 30 })!.free;
    const check = realityCheck(a, { title: "X", dueMs, minutes: free - 30 })!;
    expect(check.status).toBe("tight");
    expect(check.warning).toMatch(/^Tight: about .* free before tomorrow\.$/);
    expect(realityCheck(a, { title: "X", dueMs, minutes: free + 30 })!.status).toBe("over");
  });

  it("never doubles up when the same message already asks for time", () => {
    const plan = build([
      newTask(),
      {
        kind: "plan_time",
        title: "Physics project",
        amount: { type: "total", minutes: 120 },
        priority: "medium",
        deadlineDate: "2026-11-20",
        deadlineTime: null,
        window: "until_deadline",
        preferredDays: [],
        taskId: null,
        lifeAreaId: null,
      },
    ]);
    const minutes = plan.items.filter((i) => i.action === "schedule_block").reduce((m, s) => m + s.display.timing!.durationMinutes, 0);
    expect(minutes).toBe(120);
    expect(plan.items.some((i) => i.payload.forNewTask)).toBe(false);
  });

  it("skips the check without a due date or estimate, and for small tasks books nothing", () => {
    expect(build([newTask({ dueDate: null })]).items.map((i) => i.action)).toEqual(["create_task"]);
    expect(build([newTask({ estimatedMinutes: null })]).items.map((i) => i.action)).toEqual(["create_task"]);
    expect(build([newTask({ estimatedMinutes: 20 })]).items.map((i) => i.action)).toEqual(["create_task"]);
  });
});

describe("exam prep", () => {
  const chem = () => event({ title: "Chemistry Unit 4 Test", date: "2026-11-20", start: "09:00", end: "10:00" });

  it("reads the subject from the title and spots existing prep", () => {
    expect(subjectWords("Chemistry Unit 4 Test")).toEqual(["chemistry"]);
    expect(hasPrep("Chemistry Unit 4 Test", ["Chemistry review", "Math worksheet"])).toBe(true);
    expect(hasPrep("Chemistry Unit 4 Test", ["Chemistry Unit 4 Test", "Math worksheet"])).toBe(false);
    expect(hasPrep("Final Exam", ["Study for final exam"])).toBe(true);
  });

  it("sizes the plan by how close the exam is", () => {
    const ctx = { nowMs: NOW.getTime(), minSessionMinutes: 30, maxSessionMinutes: 90, capacity: 600 };
    const at = (h: number) => ({ title: "Bio Quiz", startMs: NOW.getTime() + h * 3_600_000 });
    expect(examPrepPlan(at(6), ctx)).toBeNull(); // too soon
    expect(examPrepPlan(at(30), ctx)).toMatchObject({ sessions: 1, minutesEach: 60 });
    expect(examPrepPlan(at(60), ctx)).toMatchObject({ sessions: 2, minutesEach: 45 });
    expect(examPrepPlan(at(120), ctx)).toMatchObject({ sessions: 3, minutesEach: 45 });
    expect(examPrepPlan(at(30 * 24), ctx)).toBeNull(); // too far
    expect(examPrepPlan(at(120), { ...ctx, capacity: 50 })).toMatchObject({ sessions: 1 });
  });

  it("Home proposes study sessions for an exam with nothing planned", () => {
    const exam = chem();
    const [c, ...rest] = examPreps(analyze(input({ events: [...weekCalendar(), exam] })));
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ kind: "exam_prep", priority: "high", commitmentIds: [exam.id] });
    expect(c.message).toBe("“Chemistry Unit 4 Test” is Friday at 9 AM, and nothing's planned to study for it. I'd book 2 study sessions of 45 min before then. Want me to?");
    expect(c.actions.map((x) => x.label)).toEqual(["Book 2 study sessions", "I'm prepared"]);
  });

  it("stays quiet when there is prep already, or the event repeats", () => {
    const exam = chem();
    const prep = task({ title: "Chemistry flashcards" });
    expect(examPreps(analyze(input({ events: [...weekCalendar(), exam], tasks: [prep] })))).toEqual([]);
    const weekly = event({ title: "Spanish quiz", date: "2026-11-20", start: "09:00", end: "10:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=FR" });
    expect(examPreps(analyze(input({ events: [...weekCalendar(), weekly] })))).toEqual([]);
  });

  it("booking the sessions puts them before the exam, through an approval card", () => {
    const exam = chem();
    const data = input({ events: [...weekCalendar(), exam] });
    const [c] = examPreps(analyze(data));
    const spec = specs(c.actions[0], data);
    if (!spec.ok || spec.prompt !== null) throw new Error("no specs");
    const plan = build(spec.specs, { events: data.events }, false);
    const sessions = plan.items.filter((i) => i.action === "schedule_block");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.autoApply === false && s.payload.title === "Study for Chemistry Unit 4 Test")).toBe(true);
    expect(sessions.every((s) => s.display.timing!.end <= exam.startsAt!)).toBe(true);
  });

  it("adding an exam in chat puts study sessions on the same card", () => {
    const plan = build([
      {
        kind: "event",
        title: "Bio Quiz",
        lifeAreaId: null,
        date: "2026-11-23",
        startTime: "10:00",
        endTime: "11:00",
        rrule: null,
        recurrenceText: null,
        location: null,
        notes: null,
      },
    ]);
    expect(plan.items[0].action).toBe("create_event");
    const sessions = plan.items.filter((i) => i.action === "schedule_block");
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.payload.title === "Study for Bio Quiz" && !s.autoApply)).toBe(true);
    expect(plan.notes.some((n) => n.startsWith("Bio Quiz is an exam"))).toBe(true);
  });

  it("a stale exam id fails cleanly", () => {
    const spec = specs({ id: "prep_exam", kind: "prep_exam", label: "x", params: { eventId: uuid(), sessions: 2, minutesEach: 45 } }, input());
    expect(spec.ok).toBe(false);
  });
});
