import { describe, expect, it, vi } from "vitest";

import { buildPlan } from "@/lib/assistant/build-plan";
import { event, NOW, PREFS, task, TZ, uuid, weekCalendar, world } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Task } from "@/lib/domain/types";
import { addDaysToKey, startOfDayInZone, zonedToUtc } from "@/lib/scheduling/zoned";
import type { Recommendation, RecommendationAction } from "@/features/proactive/types";
import { toNudge } from "@/features/home/proactive";
import { analyze, capacityBefore, type ProactiveInput } from "../analyze";
import { commitmentConflicts, deadlineClusters, detect, type Candidate } from "../detect";
import { nowNext } from "../now";
import { specsForAction } from "../specs";

vi.mock("@/lib/ai/service", () => ({
  interpretMessage: () => {
    throw new Error("AI unavailable");
  },
}));

/** NOW = Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. School 8-3 weekdays, volleyball Thu 6-8 PM. */
const due = (date: string, time = "23:59") => zonedToUtc(date, time, TZ).toISOString();

function input(over: Partial<ProactiveInput> = {}): ProactiveInput {
  return { now: NOW.toISOString(), timeZone: TZ, events: weekCalendar(), tasks: [], preferences: PREFS, ...over };
}

function session(t: Task, date: string, start: string, end: string, over: Partial<Commitment> = {}): Commitment {
  return event({ title: t.title, date, start, end, kind: "flexible", planItemId: uuid(), taskId: t.id, ...over });
}

function propose(action: RecommendationAction, data: ProactiveInput) {
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
    busy: [],
    specs: spec.specs.map((s) => ({ spec: s, explicit: false })),
    sourceMessageId: null,
  });
}

function asRec(c: Candidate): Recommendation {
  return {
    id: uuid(),
    kind: c.kind,
    priority: c.priority,
    status: "open",
    title: c.title,
    reason: c.reason,
    message: c.message,
    facts: c.facts,
    target: { taskId: c.taskId, commitmentIds: c.commitmentIds, date: c.date },
    actions: c.actions,
    dedupeKey: c.dedupeKey,
    planId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastShownAt: null,
    raisedRecently: false,
  };
}

describe("commitment conflicts", () => {
  it("asks which of two overlapping fixed events is right", () => {
    const recital = event({ title: "Piano recital", date: "2026-11-19", start: "17:00", end: "19:00" });
    const data = input({ events: [...weekCalendar(), recital] });
    const [c, ...rest] = commitmentConflicts(analyze(data));
    expect(rest).toHaveLength(0);
    expect(c.kind).toBe("commitment_conflict");
    expect(c.message).toBe("Tomorrow at 6 PM: “Piano recital” overlaps “Volleyball”. Which one is happening?");
    expect(c.priority).toBe("high");
    expect(c.actions.map((a) => a.label)).toEqual(["Keep Piano recital", "Keep Volleyball", "Both are right"]);
    expect(c.reason).toContain("1 h");
  });

  it("keeping one skips that day of a repeating event, or removes a one-off, through an approval card", () => {
    const recital = event({ title: "Piano recital", date: "2026-11-19", start: "17:00", end: "19:00" });
    const data = input({ events: [...weekCalendar(), recital] });
    const [c] = commitmentConflicts(analyze(data));

    const keepRecital = propose(c.actions[0], data);
    expect(keepRecital.items).toHaveLength(1);
    expect(keepRecital.items[0]).toMatchObject({ action: "skip_occurrence", title: "Volleyball", autoApply: false });
    expect(keepRecital.items[0].payload).toMatchObject({ date: "2026-11-19" });

    const keepVolleyball = propose(c.actions[1], data);
    expect(keepVolleyball.items).toHaveLength(1);
    expect(keepVolleyball.items[0]).toMatchObject({ action: "remove_event", title: "Piano recital", autoApply: false, targetId: recital.id });
  });

  it("ignores back-to-back events and tiny overlaps", () => {
    const after = event({ title: "Dinner", date: "2026-11-19", start: "20:00", end: "21:00" });
    const sloppy = event({ title: "Bus home", date: "2026-11-19", start: "14:55", end: "15:30" });
    expect(commitmentConflicts(analyze(input({ events: [...weekCalendar(), after, sloppy] })))).toEqual([]);
  });

  it("reports two repeating events that always overlap once, quietly", () => {
    const club = event({ title: "Robotics", date: "2026-09-03", start: "19:00", end: "20:30", recurrenceRule: "FREQ=WEEKLY;BYDAY=TH" });
    const out = commitmentConflicts(analyze(input({ now: zonedToUtc("2026-11-16", "16:00", TZ).toISOString(), events: [...weekCalendar(), club] })));
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe("low");
    expect(out[0].dedupeKey).not.toMatch(/\d{4}-\d{2}-\d{2}$/);
  });

  it("raises a repeating overlap normally when one of the events was just added", () => {
    const now = zonedToUtc("2026-11-16", "16:00", TZ);
    const club = event({
      title: "Robotics",
      date: "2026-09-03",
      start: "19:00",
      end: "20:30",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=TH",
      createdAt: new Date(now.getTime() - 3_600_000).toISOString(),
    });
    const out = commitmentConflicts(analyze(input({ now: now.toISOString(), events: [...weekCalendar(), club] })));
    expect(out[0].priority).toBe("medium");
  });

  it("calls a double entry a duplicate, and never conflicts sessions with events", () => {
    const a = event({ title: "Dentist", date: "2026-11-23", start: "16:00", end: "17:00" });
    const b = event({ title: "Dentist", date: "2026-11-23", start: "16:00", end: "17:00" });
    const essay = task({ title: "Essay", estimatedMinutes: 60 });
    const block = session(essay, "2026-11-23", "16:30", "17:30");
    const out = commitmentConflicts(analyze(input({ events: [...weekCalendar(), a, b, block], tasks: [essay] })));
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("is on your calendar twice");
    expect(out[0].actions.map((x) => x.kind)).toEqual(["resolve_conflict", "acknowledge"]);
  });

  it("'Both are right' replaces 'Not now' and dismisses for good", () => {
    const recital = event({ title: "Piano recital", date: "2026-11-19", start: "17:00", end: "19:00" });
    const [c] = commitmentConflicts(analyze(input({ events: [...weekCalendar(), recital] })));
    const nudge = toNudge(asRec(c), true);
    expect(nudge.chips.map((x) => x.label)).toEqual(["Keep Piano recital", "Keep Volleyball", "Both are right"]);
    expect(nudge.chips[2].act).toMatchObject({ kind: "dismiss", reason: "not_relevant" });
    expect(nudge.tone).toBe("suggestion");
  });
});

describe("deadline clusters", () => {
  const monday = "2026-11-23";
  const tuesday = "2026-11-24";

  function capacities() {
    const a = analyze(input());
    const before = capacityBefore(a, startOfDayInZone(monday, TZ).getTime());
    const total = capacityBefore(a, Date.parse(due(tuesday)));
    return { before, during: total - before, total };
  }

  it("flags deadlines bunched together that only fit if work starts earlier", () => {
    const { during, total } = capacities();
    const each = Math.round((during + 90) / 3);
    expect(each * 3).toBeLessThanOrEqual(total);
    const tasks = [
      task({ title: "Bio essay", dueAt: due(monday), estimatedMinutes: each }),
      task({ title: "Chem lab", dueAt: due(monday), estimatedMinutes: each }),
      task({ title: "History notes", dueAt: due(tuesday), estimatedMinutes: each }),
    ];
    const data = input({ tasks });
    const out = deadlineClusters(analyze(data));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "deadline_cluster", date: monday, dedupeKey: `deadline_cluster:${monday}:${tuesday}` });
    expect(out[0].message).toMatch(/^You have 3 deadlines between Monday and Tuesday, about .+ of work, with about .+ free then\. Start earlier\?$/);
    expect(out[0].facts[0]).toBe("Bio essay, Chem lab, History notes");

    // "Start earlier" plans all three together; the planner puts work before Monday.
    const plan = propose(out[0].actions[0], data);
    const blocks = plan.items.filter((i) => i.action === "schedule_block");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.display.timing!.date < monday)).toBe(true);
    expect(plan.items.every((i) => !i.autoApply)).toBe(true);
  });

  it("stays quiet when the work fits on those days anyway", () => {
    const tasks = [
      task({ title: "Bio essay", dueAt: due(monday), estimatedMinutes: 30 }),
      task({ title: "Chem lab", dueAt: due(tuesday), estimatedMinutes: 30 }),
    ];
    expect(deadlineClusters(analyze(input({ tasks })))).toEqual([]);
  });

  it("leaves 'not enough time at all' to the existing overload detectors", () => {
    const { total } = capacities();
    const tasks = [
      task({ title: "Bio essay", dueAt: due(monday), estimatedMinutes: total }),
      task({ title: "Chem lab", dueAt: due(tuesday), estimatedMinutes: 300 }),
    ];
    const all = detect(input({ tasks }));
    expect(all.filter((c) => c.kind === "deadline_cluster")).toEqual([]);
    expect(all.some((c) => c.kind === "overload_week" || c.kind === "deadline_at_risk")).toBe(true);
  });

  it("ignores single deadlines and ones already scheduled", () => {
    const essay = task({ title: "Bio essay", dueAt: due(monday), estimatedMinutes: 240 });
    const lab = task({ title: "Chem lab", dueAt: due(monday), estimatedMinutes: 60 });
    const booked = [session(lab, "2026-11-19", "16:00", "17:00")];
    expect(deadlineClusters(analyze(input({ tasks: [essay, lab], events: [...weekCalendar(), ...booked] })))).toEqual([]);
  });
});

describe("now / next", () => {
  const practice = () => event({ title: "Practice", date: "2026-11-18", start: "17:00", end: "18:30" });

  it("names the window, what ends it, and a task that fits", () => {
    const big = task({ title: "Bio essay", dueAt: due("2026-11-19"), estimatedMinutes: 90 });
    const lab = task({ title: "Chem lab report", dueAt: due("2026-11-20"), estimatedMinutes: 30 });
    const n = nowNext(analyze(input({ events: [...weekCalendar(), practice()], tasks: [big, lab] })))!;
    expect(n.state).toBe("free");
    expect(n.next?.title).toBe("Practice");
    // The top task (90 min, one sitting) doesn't fit the 35 free minutes: the next one that fits is offered instead.
    expect(n.task).toMatchObject({ taskId: lab.id, fit: "whole" });
    expect(n.message).toBe("Free until Practice at 5 PM. Enough time for “Chem lab report” (about 30 min).");
  });

  it("offers progress on multi-session work, never a made-up smaller task", () => {
    const big = task({ title: "Research paper", dueAt: due("2026-11-20"), estimatedMinutes: 300 });
    const later = event({ title: "Practice", date: "2026-11-18", start: "17:30", end: "18:30" });
    expect(nowNext(analyze(input({ events: [...weekCalendar(), practice()], tasks: [big] })))!.task).toBeNull(); // 35 min: too short to start it
    const n = nowNext(analyze(input({ events: [...weekCalendar(), later], tasks: [big] })))!;
    expect(n.task).toMatchObject({ taskId: big.id, fit: "progress", minutes: 300 });
    expect(n.message).toContain("A good window to make progress on “Research paper”, about 5 h left.");
  });

  it("suggests nothing when no task fits, and says so plainly", () => {
    const big = task({ title: "Bio essay", dueAt: due("2026-11-19"), estimatedMinutes: 90 });
    const n = nowNext(analyze(input({ events: [...weekCalendar(), practice()], tasks: [big] })))!;
    expect(n.task).toBeNull();
    expect(n.message).toBe("Free until Practice at 5 PM (35 min).");
  });

  it("skips tasks whose time is already booked", () => {
    const lab = task({ title: "Chem lab report", dueAt: due("2026-11-20"), estimatedMinutes: 45 });
    const booked = session(lab, "2026-11-19", "16:00", "16:45");
    const n = nowNext(analyze(input({ events: [...weekCalendar(), practice(), booked], tasks: [lab] })))!;
    expect(n.task).toBeNull();
  });

  it("during a Whitespace session, says so", () => {
    const lab = task({ title: "Chem lab report", dueAt: due("2026-11-20"), estimatedMinutes: 60 });
    const live = session(lab, "2026-11-18", "15:45", "16:45");
    const n = nowNext(analyze(input({ events: [...weekCalendar(), live], tasks: [lab] })))!;
    expect(n).toMatchObject({ state: "session", message: "Now: Chem lab report, until 4:45 PM." });
  });

  it("returns nothing outside working hours", () => {
    const late = zonedToUtc("2026-11-18", "23:00", TZ).toISOString();
    expect(nowNext(analyze(input({ now: late })))).toBeNull();
  });
});

describe("plan vs reality", () => {
  it("a session recorded as missed did no work, and the engine offers a new slot", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 120 });
    const past = session(essay, "2026-11-17", "16:00", "17:00", { outcome: "missed" });
    const data = input({ events: [...weekCalendar(), past], tasks: [essay] });
    expect(analyze(data).tasks[0].remaining).toBe(120);
    const c = detect(data).find((x) => x.kind === "missed_session")!;
    expect(c.message).toContain("didn't happen");
  });

  it("a session recorded as done (or partly) is not asked about again", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 120 });
    for (const outcome of ["done", "partial"] as const) {
      const past = session(essay, "2026-11-17", "16:00", "17:00", { outcome });
      const data = input({ events: [...weekCalendar(), past], tasks: [essay] });
      expect(analyze(data).tasks[0].remaining).toBe(60);
      expect(detect(data).some((x) => x.kind === "missed_session")).toBe(false);
    }
  });

  it("an unrecorded past session still asks 'did it happen?'", () => {
    const essay = task({ title: "Essay", dueAt: due("2026-11-25"), estimatedMinutes: 120 });
    const past = session(essay, "2026-11-17", "16:00", "17:00");
    const c = detect(input({ events: [...weekCalendar(), past], tasks: [essay] })).find((x) => x.kind === "missed_session")!;
    expect(c.title).toBe("Did the Essay session happen?");
  });
});

describe("schedule_tasks spec", () => {
  it("skips tasks without an estimate and fails cleanly when none are left", () => {
    const open = task({ title: "Read", dueAt: due(addDaysToKey("2026-11-18", 3)) });
    const r = specsForAction(
      { id: "schedule_tasks", kind: "schedule_tasks", label: "Start earlier", params: { taskIds: [open.id] } },
      { todayKey: "2026-11-18", timeZone: TZ, tasks: new Map([[open.id, open]]), events: new Map(), maxSessionMinutes: 90, nowMs: NOW.getTime() },
    );
    expect(r.ok).toBe(false);
  });
});
