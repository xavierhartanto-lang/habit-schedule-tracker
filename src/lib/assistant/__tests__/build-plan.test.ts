import { describe, expect, it } from "vitest";

import type { Commitment } from "@/lib/domain/types";
import { expandEvents } from "@/lib/scheduling/recurrence";
import { dateKeyInZone, timeKeyInZone, zonedToUtc } from "@/lib/scheduling/zoned";
import { assessIntent, type ActionSpec } from "../assess";
import { buildPlan, type BuildInput } from "../build-plan";
import { toOp } from "../ops";
import { applyPreferenceChanges } from "../prefs";
import { NOW, PREFS, TZ, date, event, intent, task, uuid, weekCalendar, world } from "./fixtures";

function specOf(i: ReturnType<typeof intent>, w = world()): { spec: ActionSpec; explicit: boolean } {
  const a = assessIntent(i, w);
  if (a.status !== "ready") throw new Error(`not ready: ${JSON.stringify(a)}`);
  return { spec: a.spec, explicit: i.explicit };
}

function input(partial: Partial<BuildInput>): BuildInput {
  return {
    now: NOW.toISOString(),
    world: world(),
    preferences: PREFS,
    events: weekCalendar(),
    openTasks: [],
    busy: [],
    specs: [],
    sourceMessageId: null,
    ...partial,
  };
}

function overlapsAny(start: string, end: string, events: Commitment[]): string[] {
  const occ = expandEvents(events, new Date(Date.parse(start) - 86_400_000), new Date(Date.parse(end) + 86_400_000), TZ);
  return occ.filter((o) => o.start < new Date(end) && o.end > new Date(start)).map((o) => o.event.title);
}

describe("conversation-based planning", () => {
  it("exam next Friday + 3 hours of study + piano twice", () => {
    // "I have a chemistry exam next Friday at 9. I need around three hours to study, and I want to practice piano twice (30 min)."
    const exam = intent({ type: "create_event", title: "Chemistry exam", evidence: "chemistry exam", date: date({ weekday: "fr", week: "next" }), start_time: "09:00", duration_minutes: 60, recurrence: "once", area: "Academics" });
    const study = intent({ type: "plan_time", title: "Study for chemistry exam", evidence: "three hours to study", amount_kind: "total", amount_minutes: 180, deadline: date({ weekday: "fr", week: "next" }), area: "Academics" });
    const piano = intent({ type: "plan_time", title: "Piano practice", evidence: "piano twice", amount_kind: "sessions", session_count: 2, session_minutes: 30, window: "this_week", area: "Hobbies" });
    const events = weekCalendar();
    const plan = buildPlan(input({ events, specs: [specOf(exam), specOf(study), specOf(piano)] }));

    expect(plan.kind).toBe("schedule");
    const examItem = plan.items.find((i) => i.action === "create_event")!;
    expect(examItem.display.timing).toMatchObject({ date: "2026-11-27", startTime: "09:00", endTime: "10:00" });

    const blocks = plan.items.filter((i) => i.action === "schedule_block");
    const studyBlocks = blocks.filter((b) => String(b.payload.title).startsWith("Study"));
    const pianoBlocks = blocks.filter((b) => String(b.payload.title).startsWith("Piano"));
    expect(studyBlocks.reduce((s, b) => s + b.display.timing!.durationMinutes, 0)).toBe(180);
    expect(studyBlocks.length).toBeGreaterThan(1); // split into sessions
    expect(pianoBlocks).toHaveLength(2);
    // Numbered in calendar order, and the reason doesn't repeat the numbering.
    const pianoTitles = pianoBlocks
      .slice()
      .sort((a, b) => Date.parse(String(a.payload.startsAt)) - Date.parse(String(b.payload.startsAt)))
      .map((b) => b.title);
    expect(pianoTitles).toEqual(["Piano practice (1 of 2)", "Piano practice (2 of 2)"]);
    expect(blocks.every((b) => !/Session \d/.test(b.display.reason ?? ""))).toBe(true);
    expect(pianoBlocks.every((b) => b.display.timing!.durationMinutes === 30)).toBe(true);

    const examStart = Date.parse(String(examItem.payload.startsAt));
    for (const b of blocks) {
      // Never on top of school, volleyball or the exam, never in the past, always explained.
      expect(overlapsAny(String(b.payload.startsAt), String(b.payload.endsAt), events)).toEqual([]);
      expect(Date.parse(String(b.payload.startsAt))).toBeGreaterThan(NOW.getTime());
      expect(b.display.reason).toBeTruthy();
      expect(b.autoApply).toBe(false);
    }
    for (const b of studyBlocks) expect(Date.parse(String(b.payload.endsAt))).toBeLessThanOrEqual(examStart);
    // Piano stays inside this week (ends Sunday Nov 22).
    for (const b of pianoBlocks) expect(b.display.timing!.date <= "2026-11-22").toBe(true);
    // Blocks never overlap each other.
    const sorted = blocks.map((b) => [Date.parse(String(b.payload.startsAt)), Date.parse(String(b.payload.endsAt))]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBeGreaterThanOrEqual(sorted[i - 1][1]);
    expect(plan.unscheduled).toEqual([]);
  });

  it("is honest when there is not enough time", () => {
    const cram = intent({ type: "plan_time", title: "Project", evidence: "project", amount_kind: "total", amount_minutes: 20 * 60, deadline: date({ day_offset: 1 }) });
    const plan = buildPlan(input({ specs: [specOf(cram)] }));
    expect(plan.unscheduled).toHaveLength(1);
    expect(plan.unscheduled[0].minutes).toBeGreaterThan(0);
    expect(plan.unscheduled[0].reason.length).toBeGreaterThan(5);
    expect(plan.summary).toBeTruthy();
  });

  it("respects task deadlines from existing tasks", () => {
    const essay = task({ title: "History essay", estimatedMinutes: 120, dueAt: zonedToUtc("2026-11-20", "08:00", TZ).toISOString(), priority: "high" });
    const w = world();
    w.refs.tasks.set("t1", essay);
    const i = intent({ type: "plan_time", evidence: "my essay", target_ref: "t1" });
    const plan = buildPlan(input({ world: w, openTasks: [essay], specs: [specOf(i, w)] }));
    const blocks = plan.items.filter((b) => b.action === "schedule_block");
    expect(blocks.reduce((s, b) => s + b.display.timing!.durationMinutes, 0)).toBe(120);
    for (const b of blocks) {
      expect(Date.parse(String(b.payload.endsAt))).toBeLessThanOrEqual(Date.parse(essay.dueAt!));
      expect(b.payload.taskId).toBe(essay.id);
    }
  });
});

describe("planning a task twice", () => {
  const due = zonedToUtc("2026-11-20", "08:00", TZ).toISOString();
  function essaySetup() {
    const essay = task({ title: "History essay", estimatedMinutes: 120, dueAt: due, priority: "high" });
    const w = world();
    w.refs.tasks.set("t1", essay);
    const spec = specOf(intent({ type: "plan_time", evidence: "my essay", target_ref: "t1" }), w);
    return { essay, w, spec };
  }
  const minutesOf = (plan: ReturnType<typeof buildPlan>) =>
    plan.items.filter((b) => b.action === "schedule_block").reduce((s, b) => s + b.display.timing!.durationMinutes, 0);

  it("only books what's left when part of the task is already on the calendar", () => {
    const { essay, w, spec } = essaySetup();
    const booked = { ...event({ title: "History essay (1 of 2)", date: "2026-11-18", start: "19:00", end: "20:00", kind: "flexible" }), planItemId: uuid(), taskId: essay.id };
    const plan = buildPlan(input({ world: w, openTasks: [essay], events: [...weekCalendar(), booked], specs: [spec] }));
    expect(minutesOf(plan)).toBe(60);
  });

  it("only books what's left when part of the task is waiting for approval", () => {
    const { essay, w, spec } = essaySetup();
    const pending = { start: zonedToUtc("2026-11-18", "19:00", TZ).toISOString(), end: zonedToUtc("2026-11-18", "20:00", TZ).toISOString(), title: "History essay", taskId: essay.id };
    const plan = buildPlan(input({ world: w, openTasks: [essay], busy: [pending], specs: [spec] }));
    expect(minutesOf(plan)).toBe(60);
  });

  it("books nothing new once the whole estimate is covered", () => {
    const { essay, w, spec } = essaySetup();
    const booked = { ...event({ title: "History essay", date: "2026-11-18", start: "18:00", end: "20:00", kind: "flexible" }), planItemId: uuid(), taskId: essay.id };
    const plan = buildPlan(input({ world: w, openTasks: [essay], events: [...weekCalendar(), booked], specs: [spec] }));
    expect(minutesOf(plan)).toBe(0);
    expect(plan.notes.join(" ")).toContain("History essay");
  });
});

describe("events from conversation", () => {
  it("shows conflicts with existing commitments but never blocks the user's own event", () => {
    const i = intent({ type: "create_event", title: "Basketball", evidence: "extra basketball practice tomorrow", date: date({ day_offset: 1 }), start_time: "18:30", duration_minutes: 90, recurrence: "once" });
    const plan = buildPlan(input({ specs: [specOf(i)] }));
    const item = plan.items[0];
    expect(item.action).toBe("create_event");
    expect(item.display.conflicts.map((c) => c.title)).toEqual(["Volleyball"]);
    expect(item.display.tradeoffs[0]).toContain("Overlaps Volleyball");
    expect(item.autoApply).toBe(false);
  });

  it("recurring events repeat at the same local time across daylight saving", () => {
    // Nov 1 2026: US clocks go back. A Thursday 18:00 event created in October.
    const oct = buildPlan(
      input({
        now: zonedToUtc("2026-10-28", "12:00", TZ).toISOString(),
        world: { ...world(), todayKey: "2026-10-28" },
        specs: [specOf(intent({ type: "create_event", title: "Robotics", evidence: "robotics", recurrence: "weekly", days: ["th"], start_time: "18:00", duration_minutes: 60 }), { ...world(), todayKey: "2026-10-28" })],
      }),
    );
    const payload = oct.items[0].payload;
    expect(payload.rrule).toBe("FREQ=WEEKLY;BYDAY=TH");
    const asEvent: Commitment = { id: uuid(), title: "Robotics", area: null, kind: "fixed", startsAt: String(payload.startsAt), endsAt: String(payload.endsAt), recurrenceRule: String(payload.rrule), timezone: TZ };
    const occ = expandEvents([asEvent], new Date("2026-10-28T00:00:00Z"), new Date("2026-11-10T00:00:00Z"), TZ);
    expect(occ.map((o) => timeKeyInZone(o.start, TZ))).toEqual(["18:00", "18:00"]);
    expect(occ.map((o) => o.start.toISOString())).toEqual(["2026-10-30T01:00:00.000Z", "2026-11-06T02:00:00.000Z"]);
  });
});

describe("auto-apply rules", () => {
  it("applies explicit organizational requests, keeps everything else for approval", () => {
    const explicitTask = intent({ type: "create_task", title: "Buy notebook", evidence: "add a task", explicit: true });
    const mentionedTask = intent({ type: "create_task", title: "Read chapter 4", evidence: "I need to read chapter 4" });
    const fact = intent({ type: "save_fact", title: "Likes drawing", evidence: "I like drawing", fact_category: "interest", explicit: true });
    const plan = buildPlan(input({ specs: [specOf(explicitTask), specOf(mentionedTask), specOf(fact)] }));
    expect(plan.items.map((i) => [i.action, i.autoApply])).toEqual([
      ["create_task", true],
      ["create_task", false],
      ["save_fact", false], // Phase 2 "Ask first": facts wait for Save.
    ]);
    expect(plan.kind).toBe("actions");
  });
});

describe("adaptive rescheduling", () => {
  function blockOn(dateKey: string, title: string, taskId: string | null = null): Commitment {
    return { ...event({ title, date: dateKey, start: "16:00", end: "17:00" }), kind: "flexible", planItemId: uuid(), taskId };
  }

  it("\"I can't study Thursday anymore\" moves the session to another day, with approval", () => {
    const block = blockOn("2026-11-19", "Study for chemistry");
    const w = world();
    w.refs.blocks.set("b1", block);
    const i = intent({ type: "cant_make", title: "study", evidence: "can't study Thursday", date: date({ weekday: "th" }) });
    const plan = buildPlan(input({ world: w, events: [...weekCalendar(), block], specs: [specOf(i, w)] }));
    expect(plan.kind).toBe("reschedule");
    const move = plan.items.find((x) => x.action === "move_block")!;
    expect(move).toBeTruthy();
    expect(move.targetId).toBe(block.id);
    expect(move.display.previous?.start).toBe(block.startsAt);
    expect(move.display.timing!.date).not.toBe("2026-11-19");
    expect(move.autoApply).toBe(false);
    expect(toOp({ id: uuid(), action: "move_block", payload: move.payload }).ok).toBe(true);
  });

  it("a new event that collides with a scheduled session proposes moving the session", () => {
    const block = blockOn("2026-11-19", "Study for chemistry");
    const i = intent({ type: "create_event", title: "Basketball", evidence: "extra basketball practice tomorrow", date: date({ day_offset: 1 }), start_time: "15:30", duration_minutes: 120, recurrence: "once" });
    const plan = buildPlan(input({ events: [...weekCalendar(), block], specs: [specOf(i)] }));
    expect(plan.items.map((x) => x.action)).toEqual(["create_event", "move_block"]);
    const moved = plan.items[1];
    expect(overlapsAny(String(moved.payload.startsAt), String(moved.payload.endsAt), weekCalendar())).toEqual([]);
    const basketball = plan.items[0];
    expect(Date.parse(String(moved.payload.startsAt)) >= Date.parse(String(basketball.payload.endsAt)) || Date.parse(String(moved.payload.endsAt)) <= Date.parse(String(basketball.payload.startsAt))).toBe(true);
  });

  it("\"I finished my coding project early\" proposes completing the task (one tap, no silent save) and offers to free its sessions", () => {
    const project = task({ title: "Coding project", estimatedMinutes: 240 });
    const b1 = blockOn("2026-11-19", "Coding project", project.id);
    const b2 = blockOn("2026-11-21", "Coding project", project.id);
    const w = world();
    w.refs.tasks.set("t1", project);
    const i = intent({ type: "finished_early", evidence: "finished my coding project early", target_ref: "t1", explicit: true });
    const plan = buildPlan(input({ world: w, openTasks: [project], events: [...weekCalendar(), b1, b2], specs: [specOf(i, w)] }));
    expect(plan.items.map((x) => [x.action, x.autoApply])).toEqual([
      ["complete_task", false],
      ["remove_block", false],
      ["remove_block", false],
    ]);
  });

  it("skips one date of a recurring fixed event instead of deleting it", () => {
    const [, volleyball] = weekCalendar();
    const w = world();
    w.refs.events.set("e1", volleyball);
    const i = intent({ type: "cant_make", evidence: "can't make volleyball Thursday", target_ref: "e1", date: date({ weekday: "th" }) });
    const plan = buildPlan(input({ world: w, events: [volleyball], specs: [specOf(i, w)] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "skip_occurrence", targetId: volleyball.id, payload: { date: "2026-11-19" } });
  });

  it("\"cancel all math tutoring\" proposes removing the whole series, never automatically", () => {
    const tutoring = event({ title: "Math tutoring", date: "2026-09-02", start: "18:00", end: "19:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" });
    const w = world();
    weekCalendar().forEach((e, n) => w.refs.events.set(`e${n + 1}`, e));
    w.refs.events.set("e3", tutoring);
    const i = intent({ type: "remove_event", title: "math tutoring", evidence: "cancel all math tutoring", explicit: true });
    const plan = buildPlan(input({ world: w, events: [...weekCalendar(), tutoring], specs: [specOf(i, w)] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "remove_event", targetId: tutoring.id, autoApply: false, payload: { commitmentId: tutoring.id } });
    expect(plan.items[0].display.detail).toBe("Every week on Wed, 6 PM-7 PM");
    expect(toOp({ id: uuid(), action: "remove_event", payload: plan.items[0].payload })).toMatchObject({ ok: true, op: { op: "delete_event", id: tutoring.id } });
  });

  it("removing something that isn't on the calendar changes nothing and says so", () => {
    const i = intent({ type: "remove_event", title: "Chess club", evidence: "cancel chess club" });
    const a = assessIntent(i, world());
    expect(a.status).toBe("skip");
    if (a.status === "skip") expect(a.note).toContain("Chess club");
  });

  it("deletes a task when asked, after approval, with undo", () => {
    const essay = task({ title: "History essay", estimatedMinutes: 120 });
    const w = world();
    w.refs.tasks.set("t1", essay);
    const i = intent({ type: "remove_task", title: "essay", evidence: "delete my essay task", target_ref: "t1", explicit: true });
    const plan = buildPlan(input({ world: w, openTasks: [essay], specs: [specOf(i, w)] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "remove_task", targetId: essay.id, autoApply: false, payload: { taskId: essay.id } });
    expect(toOp({ id: uuid(), action: "remove_task", payload: plan.items[0].payload })).toMatchObject({ ok: true, op: { op: "remove_task", id: essay.id } });
  });

  it("removing something that's only a task removes the task instead of saying it isn't on the calendar", () => {
    const sheet = task({ title: "Chem worksheet" });
    const w = world();
    w.refs.tasks.set("t1", sheet);
    const plan = buildPlan(input({ world: w, openTasks: [sheet], specs: [specOf(intent({ type: "remove_event", title: "chem worksheet", evidence: "remove the chem worksheet" }), w)] }));
    expect(plan.items.map((x) => [x.action, x.targetId])).toEqual([["remove_task", sheet.id]]);
    expect(plan.notes).toEqual([]);
  });

  it("asks which event when the name matches different events", () => {
    const w = world();
    w.refs.events.set("e1", event({ title: "Math tutoring", date: "2026-11-18", start: "18:00", end: "19:00" }));
    w.refs.events.set("e2", event({ title: "Math club", date: "2026-11-19", start: "15:00", end: "16:00" }));
    const a = assessIntent(intent({ type: "remove_event", title: "math", evidence: "cancel math" }), w);
    expect(a.status).toBe("needs");
    if (a.status === "needs") expect(a.clarify.choices).toEqual(["Math tutoring", "Math club"]);
  });

  it("\"not enough time this week\" re-plans open work and reports what doesn't fit", () => {
    const big = task({ title: "Science fair", estimatedMinutes: 900, dueAt: zonedToUtc("2026-11-20", "23:59", TZ).toISOString(), priority: "high" });
    const small = task({ title: "Spanish vocab", estimatedMinutes: 30, dueAt: zonedToUtc("2026-11-21", "23:59", TZ).toISOString() });
    const i = intent({ type: "not_enough_time", evidence: "enough time this week", window: "this_week" });
    const plan = buildPlan(input({ openTasks: [big, small], specs: [specOf(i)] }));
    expect(plan.kind).toBe("reschedule");
    expect(plan.unscheduled.map((u) => u.title)).toContain("Science fair");
    expect(plan.items.some((x) => x.action === "schedule_block" && x.payload.taskId === small.id)).toBe(true);
  });
});

describe("approval payloads", () => {
  it("validates payloads again before writing", () => {
    expect(toOp({ id: uuid(), action: "schedule_block", payload: { title: "x", startsAt: "2026-11-20T10:00:00Z", endsAt: "2026-11-20T09:00:00Z", timezone: TZ } })).toEqual({
      ok: false,
      error: "The end must be after the start.",
    });
    const ok = toOp({ id: uuid(), action: "schedule_block", payload: { title: "Study", startsAt: "2026-11-20T10:00:00Z", endsAt: "2026-11-20T11:00:00Z", timezone: TZ } });
    expect(ok.ok && ok.op).toMatchObject({ op: "insert_commitment", guard: true, row: { kind: "flexible" } });
    const done = toOp({ id: uuid(), action: "complete_task", payload: { taskId: uuid() } });
    expect(done.ok && done.op).toMatchObject({ op: "update_task", patch: { status: "done" } });
    expect(toOp({ id: uuid(), action: "set_life_area", payload: { table: "profiles", id: uuid(), lifeAreaId: null } }).ok).toBe(false);
  });

  it("preference changes narrow working hours and add protected time", () => {
    const next = applyPreferenceChanges(PREFS, {
      dayStart: null,
      dayEnd: "21:00",
      maxSessionMinutes: 60,
      bufferMinutes: null,
      protectedTime: { label: "Dinner", days: ["mo", "tu", "we", "th", "fr", "sa", "su"], start: "18:00", end: "19:00" },
    });
    expect(next.workingHours.mo.at(-1)?.end).toBe("21:00");
    expect(next.maxSessionMinutes).toBe(60);
    expect(next.protectedTimes.map((p) => p.label)).toContain("Dinner");
    expect(PREFS.maxSessionMinutes).not.toBe(60); // input untouched
    expect(dateKeyInZone(NOW, TZ)).toBe("2026-11-18");
  });
});
