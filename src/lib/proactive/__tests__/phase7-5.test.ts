import { describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/assistant/build-plan";
import type { ActionSpec } from "@/lib/assistant/assess";
import { event, NOW, PREFS, task, TZ, uuid, weekCalendar, world } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Task } from "@/lib/domain/types";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import type { DailyBrief, ProactiveState } from "@/features/proactive/types";
import { homeProactive } from "@/features/home/proactive";
import { analyze, type ProactiveInput } from "../analyze";
import { buildBrief } from "../brief";
import { catchUpPlan } from "../catch-up";
import { detect } from "../detect";
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

function build(list: ActionSpec[], data: { events?: Commitment[]; tasks?: Task[] } = {}) {
  return buildPlan({
    now: NOW.toISOString(),
    world: world(),
    preferences: PREFS,
    events: data.events ?? weekCalendar(),
    openTasks: data.tasks ?? [],
    busy: [],
    specs: list.map((spec) => ({ spec, explicit: true })),
    sourceMessageId: null,
  });
}

function session(t: Task | null, title: string, date: string, start: string, end: string): Commitment {
  return event({ title, date, start, end, kind: "flexible", planItemId: uuid(), taskId: t?.id ?? null });
}

describe("I'm behind: catch-up plan", () => {
  it("plans overdue work first, then what's due this week, when it all fits", () => {
    const late = task({ title: "Bio worksheet", dueAt: due("2026-11-17"), estimatedMinutes: 60 });
    const soon = task({ title: "Lab report", dueAt: due("2026-11-20"), estimatedMinutes: 90 });
    const later = task({ title: "Essay", dueAt: due("2026-12-10"), estimatedMinutes: 120 });
    const plan = catchUpPlan(analyze(input({ tasks: [soon, late, later] })));
    expect(plan.keep.map((k) => k.t.task.title)).toEqual(["Bio worksheet", "Lab report"]);
    expect(plan.leftOut).toEqual([]);
    expect(plan.behind).toBe(true); // something is overdue
    expect(plan.summary).toContain("everything overdue or due this week fits");
  });

  it("when it can't all fit, lets the least important work wait, never the more important", () => {
    const tasks = [
      task({ title: "Chem test review", dueAt: due("2026-11-19"), estimatedMinutes: 180, priority: "high" }),
      task({ title: "Reading log", dueAt: due("2026-11-19"), estimatedMinutes: 150, priority: "low" }),
      task({ title: "Math set", dueAt: due("2026-11-19"), estimatedMinutes: 120, priority: "medium" }),
    ];
    const plan = catchUpPlan(analyze(input({ tasks })));
    expect(plan.keep.map((k) => k.t.task.title)).toContain("Chem test review");
    expect(plan.leftOut.map((l) => l.title)).toContain("Reading log");
    expect(plan.leftOut.every((l) => l.title !== "Chem test review")).toBe(true);
    expect(plan.leftOut.find((l) => l.title === "Reading log")!.reason).toMatch(/^Low priority, due tomorrow\./);
    expect(plan.behind).toBe(true);
  });

  it("is not behind with nothing overdue and everything fitting", () => {
    const plan = catchUpPlan(analyze(input({ tasks: [task({ title: "Essay", dueAt: due("2026-11-24"), estimatedMinutes: 60 })] })));
    expect(plan.behind).toBe(false);
  });

  it("the chat's 'I'm behind' builds one card: sessions for what fits, the rest left for later", () => {
    const tasks = [
      task({ title: "Chem test review", dueAt: due("2026-11-19"), estimatedMinutes: 240, priority: "high" }),
      task({ title: "Reading log", dueAt: due("2026-11-19"), estimatedMinutes: 180, priority: "low" }),
    ];
    const plan = build([{ kind: "not_enough_time", window: "this_week" }], { tasks });
    const blocks = plan.items.filter((i) => i.action === "schedule_block");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.payload.taskId === tasks[0].id && !b.autoApply)).toBe(true);
    expect(plan.unscheduled).toEqual([expect.objectContaining({ title: "Reading log", minutes: 0 })]);
    expect(plan.notes.some((n) => n.startsWith("Catch-up plan"))).toBe(true);
  });

  it("Home offers 'I'm behind' when the brief says so", () => {
    const late = task({ title: "Bio worksheet", dueAt: due("2026-11-17"), estimatedMinutes: 60 });
    const brief = buildBrief(analyze(input({ tasks: [late] })));
    expect(brief.behind).toBe(true);
    const state: ProactiveState = {
      settings: { proactivity: "balanced", quietHoursStart: null, quietHoursEnd: null },
      quiet: false,
      today: brief,
      recommendations: [],
      openCount: 0,
    };
    const home = homeProactive(state, true, NOW);
    expect(home.opening!.chips.map((c) => c.label)).toContain("I'm behind");
    // Without anything else to lead with, it leads on its own.
    const bare: DailyBrief = { ...brief, action: null, message: "" };
    const alone = homeProactive({ ...state, today: bare }, true, NOW);
    expect(alone.opening).toMatchObject({ chips: [{ label: "I'm behind", primary: true, act: { kind: "catch_up" } }] });
  });
});

describe("grouped repair", () => {
  it("one calendar change that breaks several sessions becomes one card that moves them all", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 180 });
    const s1 = session(essay, "Essay", "2026-11-19", "16:00", "17:00");
    const s2 = session(essay, "Essay", "2026-11-19", "20:30", "21:30");
    const tournament = event({ title: "Debate tournament", date: "2026-11-19", start: "15:30", end: "22:00" });
    const data = input({ events: [...weekCalendar(), s1, s2, tournament], tasks: [essay] });
    const broken = detect(data).filter((c) => c.kind === "plan_broken");
    expect(broken).toHaveLength(1);
    expect(broken[0].message).toMatch(/^Your calendar changed, so 2 sessions no longer fit: Essay \(tomorrow 4 PM\), Essay \(tomorrow 8:30 PM\)\. I'd move them all/);
    expect(broken[0].actions[0]).toMatchObject({ label: "Move all 2", params: { commitmentIds: [s1.id, s2.id] } });

    const spec = specsForAction(broken[0].actions[0], {
      todayKey: "2026-11-18",
      timeZone: TZ,
      tasks: new Map([[essay.id, essay]]),
      events: new Map(data.events.map((e) => [e.id, e])),
      maxSessionMinutes: 90,
      nowMs: NOW.getTime(),
    });
    if (!spec.ok || spec.prompt !== null) throw new Error("no specs");
    const plan = build(spec.specs, { events: data.events, tasks: [essay] });
    expect(plan.items.filter((i) => i.action === "move_block").map((i) => i.targetId).sort()).toEqual([s1.id, s2.id].sort());
  });

  it("a single broken session keeps its own card", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 60 });
    const s1 = session(essay, "Essay", "2026-11-19", "16:00", "17:00");
    const clash = event({ title: "Dentist", date: "2026-11-19", start: "16:00", end: "17:00" });
    const broken = detect(input({ events: [...weekCalendar(), s1, clash], tasks: [essay] })).filter((c) => c.kind === "plan_broken");
    expect(broken).toHaveLength(1);
    expect(broken[0].actions[0].label).toBe("Find another time");
  });

  it("moving an event in chat onto a session moves the session on the same card", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 60 });
    const s1 = session(essay, "Essay", "2026-11-19", "16:00", "17:00");
    const tutoring = event({ title: "Math tutoring", date: "2026-11-19", start: "20:00", end: "21:00" });
    const plan = build(
      [{ kind: "event_update", event: tutoring, scope: "all", occurrenceDate: null, change: { startTime: "16:00", endTime: "17:00" } }],
      { events: [...weekCalendar(), s1, tutoring], tasks: [essay] },
    );
    expect(plan.items.map((i) => i.action)).toEqual(["update_event", "move_block"]);
    expect(plan.items[1].targetId).toBe(s1.id);
    expect(plan.notes.some((n) => n.startsWith("1 Whitespace session would collide"))).toBe(true);
  });
});
