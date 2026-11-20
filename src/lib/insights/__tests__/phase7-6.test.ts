import { describe, expect, it } from "vitest";

import { AREAS, event, NOW, PREFS, task, TZ, uuid, weekCalendar } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Goal, Task } from "@/lib/domain/types";
import type { Recommendation } from "@/features/proactive/types";
import { analyze } from "@/lib/proactive/analyze";
import { neglectedAreas, type Candidate } from "@/lib/proactive/detect";
import { surface } from "@/lib/proactive/surface";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import { areaHistory, compareWeeks, goalTime, unionMinutes, weekTime, type AreaTimeInput } from "../area-time";
import { buildBriefingPrompt, validateBriefing } from "../briefing-ai";
import { observations } from "../observations";
import { briefingWindow, buildWeeklyFacts, factLines, factsHash, showOnHome } from "../weekly";

/** NOW = Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. The week is Mon Nov 16 - Sun Nov 22. */
const [ACADEMICS, SPORTS, HOBBIES] = AREAS;
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);

function data(events: Commitment[], tasks: Task[] = [], over: Partial<AreaTimeInput> = {}): AreaTimeInput {
  return { now: NOW.toISOString(), timeZone: TZ, weekStartsOn: 1, events, tasks, areas: AREAS, ...over };
}

function session(t: Task | null, date: string, start: string, end: string, over: Partial<Commitment> = {}): Commitment {
  return event({ title: t?.title ?? "Focus", date, start, end, kind: "flexible", planItemId: uuid(), taskId: t?.id ?? null, ...over });
}

function asRec(c: Candidate, over: Partial<Recommendation> = {}): Recommendation {
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
    ...over,
  };
}

const calendar = () => [
  event({ title: "School", date: "2026-09-01", start: "08:00", end: "15:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", lifeAreaId: ACADEMICS.id }),
  event({ title: "Volleyball", date: "2026-09-03", start: "18:00", end: "20:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=TH", lifeAreaId: SPORTS.id }),
];

describe("life-area time", () => {
  it("splits calendar time from sessions, and sessions by what the user recorded", () => {
    const essay = task({ title: "Essay", lifeAreaId: ACADEMICS.id });
    const events = [
      ...calendar(),
      session(essay, "2026-11-16", "16:00", "17:00", { outcome: "done" }),
      session(essay, "2026-11-17", "16:00", "17:00", { outcome: "missed" }),
      session(essay, "2026-11-17", "19:00", "19:30", { outcome: "partial" }),
      session(essay, "2026-11-18", "10:00", "11:00"), // past, no answer
      session(essay, "2026-11-19", "16:00", "17:30"), // still ahead
    ];
    const w = weekTime(data(events, [essay]), "2026-11-16");
    const acad = w.areas.find((a) => a.areaId === ACADEMICS.id)!;
    expect(acad.calendar).toBe(5 * 7 * 60); // school, on the calendar: never "attended"
    expect(acad.done).toBe(60);
    expect(acad.partial).toBe(30);
    expect(acad.missed).toBe(60);
    expect(acad.unrecorded).toBe(60);
    expect(acad.upcoming).toBe(90);
    // Volleyball Thursday is ahead, still counted as scheduled, never as done.
    const sports = w.areas.find((a) => a.areaId === SPORTS.id)!;
    expect(sports).toMatchObject({ calendar: 120, done: 0, scheduled: 120 });
    expect(w.totals.done).toBe(60);
  });

  it("puts sessions with no area under Unassigned, and never guesses from the title", () => {
    const loose = task({ title: "Math homework" }); // no area
    const events = [
      session(loose, "2026-11-16", "16:00", "17:00", { outcome: "done" }),
      event({ title: "Basketball practice", date: "2026-11-17", start: "16:00", end: "18:00" }), // sounds like sports, has no area
      event({ title: "Old club", date: "2026-11-17", start: "19:00", end: "20:00", lifeAreaId: "00000000-0000-4000-8000-00000000dead" }), // deleted area
    ];
    const w = weekTime(data(events, [loose]), "2026-11-16");
    expect(w.areas.map((a) => a.name)).toEqual(["Unassigned"]);
    expect(w.areas[0]).toMatchObject({ areaId: null, calendar: 180, done: 60, scheduled: 240 });
  });

  it("a session without its own area counts toward its task's area (an explicit link, not a guess)", () => {
    const lab = task({ title: "Lab report", lifeAreaId: ACADEMICS.id });
    const w = weekTime(data([session(lab, "2026-11-16", "16:00", "17:00")], [lab]), "2026-11-16");
    expect(w.areas[0]).toMatchObject({ areaId: ACADEMICS.id, unrecorded: 60 });
  });

  it("counts overlapping events in the same area once", () => {
    const a = event({ title: "Robotics", date: "2026-11-16", start: "16:00", end: "18:00", lifeAreaId: HOBBIES.id });
    const b = event({ title: "Robotics (copy)", date: "2026-11-16", start: "17:00", end: "19:00", lifeAreaId: HOBBIES.id });
    const w = weekTime(data([a, b]), "2026-11-16");
    expect(w.areas[0].calendar).toBe(180);
    expect(w.totals.scheduled).toBe(180);
    expect(unionMinutes([])).toBe(0);
  });

  it("supports custom areas and keeps the user's area order, Unassigned last", () => {
    const custom = { id: "00000000-0000-4000-8000-0000000000c1", name: "Debate", color: "pink" as const, position: 0, legacyKey: null };
    const areas = [custom, ...AREAS.map((a) => ({ ...a, position: a.position + 1 }))];
    const events = [
      event({ title: "Free time", date: "2026-11-16", start: "20:00", end: "21:00" }),
      event({ title: "Tournament prep", date: "2026-11-17", start: "16:00", end: "18:00", lifeAreaId: custom.id }),
      event({ title: "Volleyball", date: "2026-11-19", start: "18:00", end: "20:00", lifeAreaId: SPORTS.id }),
    ];
    const w = weekTime(data(events, [], { areas }), "2026-11-16");
    expect(w.areas.map((a) => a.name)).toEqual(["Debate", "Sports", "Unassigned"]);
  });

  it("uses local week boundaries, including the daylight saving change and a Sunday-first week", () => {
    // US clocks fall back on Sunday Nov 1, 2026. An event from 11 PM Sunday to 1 AM Monday splits between weeks.
    const late = event({ title: "Overnight", date: "2026-11-01", start: "23:00", end: "23:59", lifeAreaId: HOBBIES.id });
    late.endsAt = at("2026-11-02", "01:00").toISOString();
    const before = weekTime(data([late]), "2026-10-26");
    const after = weekTime(data([late]), "2026-11-02");
    expect(before.totals.calendar).toBe(60);
    expect(after.totals.calendar).toBe(60);
    expect(after.perDay[0]).toMatchObject({ date: "2026-11-02", calendar: 60 });
    // Sunday-first: Sunday Nov 1 opens the week.
    const sunday = weekTime(data([late], [], { weekStartsOn: 0 }), "2026-11-01");
    expect(sunday.days[0]).toBe("2026-11-01");
    expect(sunday.totals.calendar).toBe(120);
  });

  it("compares this week with last week, including areas only one week had", () => {
    const events = [
      event({ title: "Art", date: "2026-11-10", start: "16:00", end: "18:00", lifeAreaId: HOBBIES.id }),
      event({ title: "Game", date: "2026-11-17", start: "16:00", end: "18:00", lifeAreaId: SPORTS.id }),
      event({ title: "Game", date: "2026-11-11", start: "16:00", end: "17:00", lifeAreaId: SPORTS.id }),
    ];
    const input = data(events);
    const rows = compareWeeks(weekTime(input, "2026-11-16"), weekTime(input, "2026-11-09"));
    expect(rows).toEqual([
      expect.objectContaining({ name: "Sports", thisWeek: 120, lastWeek: 60, delta: 60 }),
      expect.objectContaining({ name: "Hobbies", thisWeek: 0, lastWeek: 120, delta: -120 }),
    ]);
  });

  it("goals are a lens over tasks, never extra time", () => {
    const goal: Goal = { id: uuid(), title: "Get a 5 on AP Bio", area: null, lifeAreaId: ACADEMICS.id, description: null, targetDate: null, status: "active", milestones: [] };
    const bio = task({ title: "Bio review", goalId: goal.id, lifeAreaId: ACADEMICS.id });
    const events = [session(bio, "2026-11-16", "16:00", "17:00", { outcome: "done" }), session(bio, "2026-11-19", "16:00", "17:00")];
    const input = data(events, [bio]);
    const w = weekTime(input, "2026-11-16");
    const g = goalTime(input, [goal], at("2026-11-16", "00:00").getTime(), at("2026-11-23", "00:00").getTime());
    expect(g).toEqual([expect.objectContaining({ title: "Get a 5 on AP Bio", scheduled: 120, worked: 60, upcoming: 60 })]);
    // The same two hours, once, in the area. Goals don't add to the total.
    expect(w.totals.scheduled).toBe(120);
  });
});

describe("weekly briefing", () => {
  it("previews next week on the last evening of the week, otherwise covers this week", () => {
    const sundayEvening = briefingWindow(at("2026-11-22", "18:00"), TZ, "2026-11-22", 1);
    expect(sundayEvening).toEqual({ weekStart: "2026-11-23", reviewStart: "2026-11-16", preview: true, offerOnHome: true });
    const sundayMorning = briefingWindow(at("2026-11-22", "10:00"), TZ, "2026-11-22", 1);
    expect(sundayMorning).toMatchObject({ weekStart: "2026-11-16", preview: false, offerOnHome: false });
    expect(briefingWindow(at("2026-11-23", "07:00"), TZ, "2026-11-23", 1)).toMatchObject({ weekStart: "2026-11-23", offerOnHome: true });
    expect(briefingWindow(at("2026-11-26", "07:00"), TZ, "2026-11-26", 1)).toMatchObject({ offerOnHome: false });
    // Sunday-first weeks: Saturday evening previews.
    expect(briefingWindow(at("2026-11-21", "19:00"), TZ, "2026-11-21", 0)).toMatchObject({ weekStart: "2026-11-22", preview: true });
  });

  it("shows on Home once: not after it was dismissed, or a day after it was first shown", () => {
    const w = briefingWindow(at("2026-11-23", "07:00"), TZ, "2026-11-23", 1);
    const now = at("2026-11-23", "08:00");
    expect(showOnHome(w, null, now)).toBe(true);
    expect(showOnHome(w, { shownAt: null, dismissedAt: null }, now)).toBe(true);
    expect(showOnHome(w, { shownAt: at("2026-11-23", "07:30").toISOString(), dismissedAt: null }, now)).toBe(true);
    expect(showOnHome(w, { shownAt: at("2026-11-22", "06:00").toISOString(), dismissedAt: null }, now)).toBe(false);
    expect(showOnHome(w, { shownAt: null, dismissedAt: at("2026-11-23", "07:40").toISOString() }, now)).toBe(false);
  });

  function facts(tasks: Task[], events: Commitment[] = weekCalendar(), recs: Recommendation[] = []) {
    const a = analyze({ now: NOW.toISOString(), timeZone: TZ, events, tasks, preferences: PREFS });
    const window = briefingWindow(NOW, TZ, "2026-11-18", 1);
    const input = data(events, tasks);
    return buildWeeklyFacts({ analysis: a, window, recommendations: recs, reviewed: weekTime(input, "2026-11-09"), before: weekTime(input, "2026-11-02") });
  }

  it("lists this week's deadlines and one-off events from real data, and the shared detectors' problems", () => {
    const lab = task({ title: "Lab report", dueAt: zonedToUtc("2026-11-20", "23:59", TZ).toISOString(), estimatedMinutes: 90, priority: "high" });
    const later = task({ title: "Essay", dueAt: zonedToUtc("2026-12-04", "23:59", TZ).toISOString(), estimatedMinutes: 60 });
    const exam = event({ title: "Chem test", date: "2026-11-20", start: "09:00", end: "10:00" });
    const overload: Candidate = {
      dedupeKey: "overload_day:2026-11-19",
      kind: "overload_day",
      priority: "medium",
      title: "Thursday looks overloaded",
      reason: "r",
      message: "Thursday's packed. Move Essay to Friday?",
      facts: [],
      actions: [{ id: "lighten_day", kind: "lighten_day", label: "Move Essay", params: {} }],
      taskId: null,
      commitmentIds: [],
      date: "2026-11-19",
    };
    const f = facts([lab, later], [...weekCalendar(), exam], [asRec(overload)]);
    expect(f.deadlines.map((d) => d.title)).toEqual(["Lab report"]);
    expect(f.commitments).toEqual([expect.objectContaining({ title: "Chem test", date: "2026-11-20", exam: true })]);
    expect(f.days.map((d) => d.date)).toEqual(["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
    expect(f.days.find((d) => d.date === "2026-11-19")!.heavy).toBe(true);
    expect(f.problems).toEqual([expect.objectContaining({ kind: "overload_day" })]);
    expect(f.actions).toEqual([expect.objectContaining({ label: "Move Essay", actionId: "lighten_day" })]);
    const lines = factLines(f, "2026-11-18");
    expect(lines[0]).toBe("Due this week: Lab report (Friday, high priority).");
    expect(lines).toContain("Heavy day: Thursday.");
    expect(lines.some((l) => l.startsWith("Problem: Thursday's packed"))).toBe(true);
    expect(f.empty).toBe(false);
  });

  it("is honestly empty when there is nothing", () => {
    const f = facts([], []);
    expect(f.empty).toBe(true);
    expect(factLines(f, "2026-11-18")[0]).toBe("Nothing is due this week.");
  });

  it("refreshes the cached summary only when something important changes", () => {
    const lab = task({ title: "Lab report", dueAt: zonedToUtc("2026-11-20", "23:59", TZ).toISOString(), estimatedMinutes: 90 });
    const base = facts([lab]);
    expect(factsHash(facts([lab]))).toBe(factsHash(base));
    const quiz = task({ title: "Quiz prep", dueAt: zonedToUtc("2026-11-19", "23:59", TZ).toISOString() });
    expect(factsHash(facts([lab, quiz]))).not.toBe(factsHash(base));
    // A few minutes of free time passing doesn't count.
    expect(factsHash({ ...base, capacityMinutes: base.capacityMinutes - 10 })).toBe(factsHash(base));
  });

  it("keeps the AI summary to the facts", () => {
    const lines = ["Due this week: Lab report (Friday, high priority).", "Heavy day: Thursday.", "About 1 h 30 min of work due this week still needs time; about 6 h of realistic free time."];
    expect(buildBriefingPrompt(lines, "Week of Nov 16")).toContain("<facts>\n- Due this week: Lab report");
    expect(validateBriefing("Thursday is your heavy day. The lab report is due Friday, and about 6 h of free time covers the 1 h 30 min it still needs.", lines)).not.toBeNull();
    expect(validateBriefing("You have 3 deadlines this week, starting Thursday.", lines)).toBeNull(); // invented number
    expect(validateBriefing("Monday is heavy and the lab report is due Friday.", lines)).toBeNull(); // invented day
    expect(validateBriefing("Don't forget “Chem test” on Friday, plus the lab report.", lines)).toBeNull(); // invented event
    expect(validateBriefing("Big week ahead! The lab report is due Friday.", lines)).toBeNull();
    expect(validateBriefing("You have three deadlines and Thursday is heavy.", lines)).toBeNull(); // spelled-out count
  });
});

describe("neglected life area", () => {
  const a = () => analyze({ now: NOW.toISOString(), timeZone: TZ, events: weekCalendar(), tasks: [], preferences: PREFS });

  it("suggests, without guilt, an area that had regular time and has had none for two weeks", () => {
    const art = [
      event({ title: "Art studio", date: "2026-10-20", start: "16:00", end: "18:00", lifeAreaId: HOBBIES.id }),
      event({ title: "Art studio", date: "2026-10-27", start: "16:00", end: "17:30", lifeAreaId: HOBBIES.id }),
    ];
    const h = areaHistory(data([...calendar(), ...art]), "2026-11-18");
    expect(h.earlier.find((e) => e.areaId === HOBBIES.id)).toMatchObject({ minutes: 210, lastDate: "2026-10-27" });
    const [c, ...rest] = neglectedAreas(a(), h);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ kind: "neglected_area", priority: "low", dedupeKey: `neglected_area:${HOBBIES.id}:2026-10-27` });
    expect(c.message).toMatch(/^Hobbies hasn't had any time in 2 weeks, and nothing's planned\. If you want it back, \w+ has room\. Want me to find an hour\?$/);
    expect(c.message).not.toMatch(/should|neglect|behind/i);
    expect(c.actions.map((x) => x.kind)).toEqual(["ask", "acknowledge"]);
  });

  it("never raises an area that still has time, one the user never used, or unassigned time", () => {
    // Academics and Sports repeat every week, so they are active.
    const h = areaHistory(data([...calendar(), event({ title: "Free time", date: "2026-10-20", start: "16:00", end: "20:00" })]), "2026-11-18");
    expect(neglectedAreas(a(), h)).toEqual([]);
    // Planned time ahead counts as active.
    const art = event({ title: "Art studio", date: "2026-10-20", start: "16:00", end: "19:00", lifeAreaId: HOBBIES.id });
    const ahead = event({ title: "Art studio", date: "2026-11-21", start: "10:00", end: "11:00", lifeAreaId: HOBBIES.id });
    expect(neglectedAreas(a(), areaHistory(data([art, ahead]), "2026-11-18"))).toEqual([]);
    // A little time once doesn't make it a regular part of the week.
    const once = event({ title: "Art studio", date: "2026-10-20", start: "16:00", end: "17:00", lifeAreaId: HOBBIES.id });
    expect(neglectedAreas(a(), areaHistory(data([once]), "2026-11-18"))).toEqual([]);
  });

  it("is low priority: only the proactive level raises it on its own", () => {
    const art = event({ title: "Art studio", date: "2026-10-20", start: "16:00", end: "19:00", lifeAreaId: HOBBIES.id });
    const [c] = neglectedAreas(a(), areaHistory(data([art]), "2026-11-18"));
    const rec = asRec(c);
    const opts = (proactivity: "minimal" | "balanced" | "proactive") => ({
      settings: { proactivity, quietHoursStart: null, quietHoursEnd: null },
      now: NOW,
      timeZone: TZ,
      mode: "home" as const,
    });
    expect(surface([rec], opts("balanced"))).toEqual([]);
    expect(surface([rec], opts("proactive"))).toEqual([rec]);
    expect(surface([{ ...rec, status: "dismissed" }], opts("proactive"))).toEqual([]);
  });
});

describe("observations", () => {
  it("states plain facts: missed and unrecorded sessions, a big shift, unassigned time", () => {
    const essay = task({ title: "Essay", lifeAreaId: ACADEMICS.id });
    const events = [
      session(essay, "2026-11-16", "16:00", "17:00", { outcome: "missed" }),
      session(essay, "2026-11-17", "16:00", "17:00"),
      event({ title: "Game", date: "2026-11-17", start: "17:30", end: "21:30", lifeAreaId: SPORTS.id }),
      event({ title: "Hangout", date: "2026-11-18", start: "09:00", end: "12:00" }),
    ];
    const input = data(events, [essay]);
    const list = observations(weekTime(input, "2026-11-16"), weekTime(input, "2026-11-09"), "2026-11-18");
    expect(list.map((o) => o.id)).toEqual(["missed", "unrecorded", `shift:${SPORTS.id}`, "unassigned"]);
    expect(list[2].body).toBe("4 h scheduled this week so far, against nothing last week.");
    for (const o of list) expect(`${o.title} ${o.body}`).not.toMatch(/score|streak|great job|lazy|should have/i);
  });

  it("doesn't report a drop while the week is still going", () => {
    const events = [event({ title: "Game", date: "2026-11-11", start: "12:00", end: "18:00", lifeAreaId: SPORTS.id })];
    const input = data(events);
    const mid = observations(weekTime(input, "2026-11-16"), weekTime(input, "2026-11-09"), "2026-11-18");
    expect(mid.some((o) => o.id.startsWith("shift"))).toBe(false);
    const done = observations(weekTime(input, "2026-11-16"), weekTime(input, "2026-11-09"), "2026-11-22");
    expect(done.find((o) => o.id.startsWith("shift"))!.title).toBe("Sports down 6 h");
  });

  it("says nothing when nothing stands out", () => {
    const input = data(calendar());
    expect(observations(weekTime(input, "2026-11-16"), weekTime(input, "2026-11-09"), "2026-11-18")).toEqual([]);
  });
});
