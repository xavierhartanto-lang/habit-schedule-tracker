import { describe, expect, it, vi } from "vitest";

import { event, NOW, PREFS, task, TZ, uuid, weekCalendar } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Task } from "@/lib/domain/types";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import { buildOpening, type OpeningInput } from "@/features/home/opening";
import { buildSystemPrompt, VOICE, type PromptContext } from "@/lib/ai/prompts";
import { analyze, type ProactiveInput } from "../analyze";
import { buildBrief } from "../brief";
import { detect } from "../detect";

/**
 * Phase 6.1 "cinematic" voice. Every sentence Whitespace writes without the
 * AI (brief, suggestion cards, Home opening) must lead with the point, stay
 * short, and skip filler. The before/after pairs document the change; the
 * facts in each "after" are asserted exactly, so brevity never costs accuracy.
 */

vi.mock("@/lib/ai/service", () => ({
  interpretMessage: () => {
    throw new Error("AI unavailable");
  },
}));

const due = (date: string, time = "23:59") => zonedToUtc(date, time, TZ).toISOString();
const input = (over: Partial<ProactiveInput> = {}): ProactiveInput => ({
  now: NOW.toISOString(),
  timeZone: TZ,
  events: weekCalendar(),
  tasks: [],
  preferences: PREFS,
  ...over,
});
const session = (t: Task, date: string, start: string, end: string): Commitment =>
  event({ title: t.title, date, start, end, kind: "flexible", planItemId: uuid(), taskId: t.id });

const FILLER = /\b(I noticed|It appears|Based on|approximately|Would you like|I would recommend|currently|looking pretty)\b/i;
const sentences = (s: string) => s.split(/(?<=[.?!])\s+/).filter(Boolean);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function expectCinematic(message: string, maxSentences = 4, maxWords = 32) {
  expect(message).not.toMatch(FILLER);
  expect(sentences(message).length).toBeLessThanOrEqual(maxSentences);
  expect(words(message)).toBeLessThanOrEqual(maxWords);
}

describe("suggestion cards: before / after", () => {
  it("deadline soon leads with the deadline and the free time", () => {
    const t = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
    const [c] = detect(input({ tasks: [t] }));
    // Before: "“History essay” is due tomorrow. You have about 6 h free before then, so I'd start this afternoon. Want me to block out time for it?"
    expect(c.message).toMatch(/^“History essay” is due tomorrow\. You've got about \d+ h( \d+ min)? free\. I'd start this afternoon\. Want me to block it out\?$/);
    expectCinematic(c.message);
  });

  it("not enough time keeps the honest numbers", () => {
    const tasks = [task({ title: "Research paper", dueAt: due("2026-11-20"), estimatedMinutes: 600, priority: "high" })];
    const risk = detect(input({ tasks })).find((c) => c.kind === "deadline_at_risk")!;
    // Before: "“Research paper” is due Friday and needs about 10 h more, but you only have about 4 h free before then. Want me to schedule what fits so you can start now?"
    expect(risk.message).toMatch(/^“Research paper” is due Friday\. It needs about 10 h, you've got about \d+ h( \d+ min)?\. Schedule what fits\?$/);
    expectCinematic(risk.message);
  });

  it("overdue gets straight to the choice", () => {
    const t = task({ title: "Lab report", dueAt: due("2026-11-17"), estimatedMinutes: 60 });
    const [c] = detect(input({ tasks: [t] }));
    // Before: "“Lab report” was due yesterday. Want me to find time to finish it, or is it already done?"
    expect(c.message).toBe("“Lab report” was due yesterday. Want me to find time, or is it done?");
  });

  it("start early names the real session count and the day it would pile onto", () => {
    const t = task({ title: "Lab report", dueAt: due("2026-11-23"), estimatedMinutes: 150 });
    const c = detect(input({ tasks: [t] })).find((x) => x.kind === "start_early")!;
    // Before: "“Lab report” is due Monday and will take about 2 h 30 min. I'd split it into 3 sessions rather than leaving it all for Sunday. Want me to schedule them?"
    expect(c.message).toBe("“Lab report” is due Monday and needs about 2 h 30 min. Better as 3 sessions than one long Sunday. Want me to schedule them?");
  });

  it("a broken plan says what clashes, in one line", () => {
    const bio = task({ title: "Biology study", dueAt: due("2026-11-21"), estimatedMinutes: 60 });
    const dentist = event({ title: "Dentist", date: "2026-11-19", start: "15:30", end: "17:00" });
    const data = input({ tasks: [bio], events: [...weekCalendar(), session(bio, "2026-11-19", "16:00", "17:00"), dentist] });
    const c = detect(data).find((x) => x.kind === "plan_broken")!;
    // Before: "Your Biology study session tomorrow at 4 PM now overlaps Dentist. Want me to find another time before it's due Saturday?"
    expect(c.message).toBe("Biology study tomorrow at 4 PM now overlaps Dentist. Want me to find another slot before it's due Saturday?");
  });

  it("every card stays short and filler-free", () => {
    const tasks = [
      task({ title: "Research paper", dueAt: due("2026-11-20"), estimatedMinutes: 600, priority: "high" }),
      task({ title: "Chem problem set", dueAt: due("2026-11-20"), estimatedMinutes: 400 }),
      task({ title: "College essay draft", dueAt: due("2026-11-27"), estimatedMinutes: 180, postponeCount: 3 }),
      task({ title: "Spanish vocab", dueAt: due("2026-11-17"), estimatedMinutes: 30 }),
    ];
    const cs = detect(input({ tasks }));
    expect(cs.length).toBeGreaterThan(3);
    for (const c of cs) expectCinematic(c.message);
  });
});

describe("daily brief: before / after", () => {
  it("leads with the deadline, then the day", () => {
    const now = zonedToUtc("2026-11-18", "09:15", TZ).toISOString();
    const t = task({ title: "History essay", dueAt: due("2026-11-19"), estimatedMinutes: 120 });
    const msg = buildBrief(analyze(input({ now, tasks: [t] }))).message;
    // Before: "You have School until 3 PM today, and “History essay” is due tomorrow. I'd get started on “History essay” this afternoon. You have about 6 h 30 min free. Want me to organize your schedule?"
    expect(msg).toBe("“History essay” is due tomorrow. School runs until 3 PM. You've got about 6 h 30 min free. I'd start this afternoon. Want me to plan the day?");
    expectCinematic(msg, 5);
  });

  it("an empty day is one line", () => {
    const msg = buildBrief(analyze(input({ events: [], tasks: [] }))).message;
    expect(sentences(msg)).toHaveLength(1);
  });
});

describe("Home opening: before / after", () => {
  const base: OpeningInput = { firstName: "Maya", hour: 9, isoWeekday: 3, remainingToday: [], deadlines: [], empty: false };

  it("an exam is named first", () => {
    const o = buildOpening({ ...base, deadlines: [{ title: "Chemistry exam", kind: "event", days: 2, weekday: "Friday", date: "Nov 20" }] });
    // Before: "You have Chemistry exam on Friday. Want to plan some study time?"
    expect(o.message).toBe("Chemistry exam is on Friday. Want me to plan study time?");
  });

  it("an empty calendar gets a short, specific ask", () => {
    const o = buildOpening({ ...base, empty: true });
    // Before: "Your calendar is empty, so let's fill in the basics. Tell me about a normal week: school hours, practices, lessons, anything that repeats."
    expectCinematic(o.message);
  });
});

describe("AI reply prompt", () => {
  const ctx: PromptContext = {
    profile: { displayName: "Maya", gradeLevel: 11, school: null, timezone: TZ },
    preferences: null,
    facts: [],
    personalizationEnabled: true,
    today: { date: "2026-11-18", weekday: "Wednesday" },
  };

  it("carries the cinematic voice rules and the tone examples", () => {
    expect(VOICE).toContain("Lead with what matters");
    expect(VOICE).toContain("one or two short sentences");
    expect(VOICE).toContain("Tuesday's double-booked. DECA overlaps with tennis.");
    expect(VOICE).toContain("Short and accurate beats short and vague");
  });

  it("keeps every honesty and approval rule next to the new voice", () => {
    const [stable] = buildSystemPrompt("assistant", ctx, { actions: null });
    expect(stable).toContain(VOICE);
    expect(stable).toContain("Never claim something was saved, scheduled, moved or deleted unless it is listed as already done");
    expect(stable).toContain("Calendar changes always wait for the user's approval");
    expect(stable).toContain("Never calculate free time or pick time slots yourself");
    expect(stable).toContain("say plainly that nothing changed");
  });

  it("check-ins open with the point, not a greeting", () => {
    const [daily] = buildSystemPrompt("assistant", ctx, { actions: null, checkIn: { kind: "daily", data: "" } });
    expect(daily).toContain("skip the greeting");
    expect(daily).toContain("Never list anything that is not in <check_in>");
  });
});
