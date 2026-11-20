import { describe, expect, it, vi } from "vitest";

import { event, NOW, PREFS, task, TODAY, TZ, weekCalendar } from "@/lib/assistant/__tests__/fixtures";
import type { Commitment, Goal, Task } from "@/lib/domain/types";
import { DEFAULT_ASSISTANT_SETTINGS, type Recommendation } from "@/features/proactive/types";
import { analyze } from "@/lib/proactive/analyze";
import { buildBrief } from "@/lib/proactive/brief";
import { addDaysToKey, zonedToUtc } from "@/lib/scheduling/zoned";
import { MAX_ADAPTIVE, MAX_CONTEXT, SLOTS, selectSections } from "../select";
import { evaluateSignals, type SignalInput } from "../signals";
import type { HomeLayout, SectionKind } from "../types";

// Home's adaptive layer must never need the AI to decide anything.
vi.mock("@/lib/ai/service", () => ({
  interpretMessage: () => {
    throw new Error("AI unavailable");
  },
}));

/** NOW = Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. School 8-3 weekdays, volleyball Thu 6-8 PM. */
const due = (days: number, time = "23:59") => zonedToUtc(addDaysToKey(TODAY, days), time, TZ).toISOString();

let n = 0;
const rec = (over: Partial<Recommendation> = {}): Recommendation =>
  ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    kind: "deadline_soon",
    priority: "medium",
    status: "open",
    title: "History essay is due tomorrow",
    reason: "Due tomorrow and nothing is scheduled.",
    message: "History essay is due tomorrow and nothing is scheduled yet. Want me to find time?",
    facts: ["Due Thu, Nov 19"],
    target: { taskId: null, commitmentIds: [], date: null },
    actions: [{ id: "schedule_work", kind: "schedule_work", label: "Find time", params: {} }],
    dedupeKey: `k${n}`,
    planId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastShownAt: null,
    raisedRecently: false,
    ...over,
  }) as Recommendation;

const goal = (title: string, over: Partial<Goal> = {}): Goal => ({
  id: `goal-${title}`,
  title,
  area: null,
  description: null,
  targetDate: null,
  status: "active",
  milestones: [],
  progress: 20,
  ...over,
});

/** Runs the real Phase 5 engine on the data, then the adaptive layer. */
function scenario(data: {
  events?: Commitment[];
  tasks?: Task[];
  recommendations?: Recommendation[];
  chatShownIds?: string[];
  goals?: Goal[] | null;
  recentlyDone?: Task[] | null;
  engine?: boolean;
}): { input: SignalInput; layout: HomeLayout } {
  const events = data.events ?? weekCalendar();
  const tasks = data.tasks ?? [];
  const analysis =
    data.engine === false ? null : analyze({ now: NOW.toISOString(), timeZone: TZ, events, tasks, preferences: PREFS });
  const input: SignalInput = {
    now: NOW,
    todayKey: TODAY,
    timeZone: TZ,
    events,
    openTasks: tasks,
    analysis,
    brief: analysis ? buildBrief(analysis) : null,
    recommendations: data.recommendations ?? [],
    settings: data.engine === false ? null : DEFAULT_ASSISTANT_SETTINGS,
    chatShownIds: data.chatShownIds ?? [],
    goals: data.goals === undefined ? [] : data.goals,
    recentlyDone: data.recentlyDone === undefined ? [] : data.recentlyDone,
    aiConfigured: true,
  };
  return { input, layout: selectSections(evaluateSignals(input)) };
}

const kinds = (l: HomeLayout) => l.sections.map((s) => s.kind);
const section = <K extends SectionKind>(l: HomeLayout, k: K) => l.sections.find((s) => s.kind === k) as Extract<HomeLayout["sections"][number], { kind: K }> | undefined;
const WARNING_KINDS: SectionKind[] = ["workload"];

describe("adaptive Home: approaching deadlines", () => {
  const essay = task({ title: "History essay", dueAt: due(1), estimatedMinutes: 120, priority: "high" });
  const lab = task({ title: "Chem lab report", dueAt: due(2), estimatedMinutes: 60 });
  const test = event({ title: "Science test", date: addDaysToKey(TODAY, 2), start: "09:00", end: "10:00" });
  const { layout } = scenario({ events: [...weekCalendar(), test], tasks: [essay, lab] });

  it("leads with what to do first, from the engine's focus", () => {
    const focus = section(layout, "focus");
    expect(focus?.data.title).toBe("History essay");
    expect(focus?.data.why).toBe("Due tomorrow");
    expect(focus?.lead).toBe(true);
  });

  it("lists the other near deadlines, without repeating the focus task", () => {
    const deadlines = section(layout, "deadlines");
    const titles = deadlines?.data.items.map((i) => i.title);
    // Time order: the 9 AM test comes before the lab due at midnight.
    expect(titles).toEqual(["Science test", "Chem lab report"]);
    expect(deadlines?.data.items.find((i) => i.title === "Science test")?.source).toBe("calendar");
    expect(deadlines?.reason).toBe("2 in the next 3 days");
  });

  it("is not a calm day", () => {
    expect(layout.calm).toBe(false);
    expect(kinds(layout)).not.toContain("open_time");
  });
});

describe("adaptive Home: unfinished work", () => {
  it("surfaces overdue tasks first", () => {
    const late = task({ title: "Math worksheet", dueAt: due(-2), priority: "medium" });
    const { layout } = scenario({ tasks: [late, task({ title: "Read ch. 4", dueAt: due(6) })] });
    expect(section(layout, "focus")?.data.why).toMatch(/^Overdue since/);
    expect(section(layout, "focus")?.priority).toBe(90);
  });

  it("shows engine suggestions the conversation isn't already showing", () => {
    const shown = rec({ title: "Shown in chat" });
    const fresh = rec({ kind: "postponed", title: "Postponed twice", message: "Bio notes keeps moving. Want to pick a firm day?" });
    const { layout } = scenario({ tasks: [task({ title: "Bio notes" })], recommendations: [shown, fresh], chatShownIds: [shown.id] });
    const items = section(layout, "suggestions")?.data.items ?? [];
    expect(items.map((i) => i.id)).toEqual([fresh.id]);
    // Every suggestion offers a "Not now", and its actions only propose.
    expect(items[0].chips.at(-1)?.act.kind).toBe("dismiss");
  });

  it("respects the user's proactivity level: nothing extra in quiet hours", () => {
    const r = rec({ title: "Something" });
    const { input } = scenario({ recommendations: [r], tasks: [task({ title: "x" })] });
    const quiet = { ...DEFAULT_ASSISTANT_SETTINGS, quietHoursStart: "15:00", quietHoursEnd: "18:00" };
    const layout = selectSections(evaluateSignals({ ...input, settings: quiet }));
    expect(kinds(layout)).not.toContain("suggestions");
  });
});

describe("adaptive Home: overloaded schedule", () => {
  it("shows a workload section when the engine flags an overload", () => {
    const overload = rec({ kind: "overload_day", priority: "high", title: "Thursday is packed", message: "Thursday has more work than time. Want me to move something?", target: { taskId: null, commitmentIds: [], date: addDaysToKey(TODAY, 1) } });
    const { layout } = scenario({ tasks: [task({ title: "Essay", dueAt: due(5) })], recommendations: [overload] });
    const workload = section(layout, "workload");
    expect(workload).toBeDefined();
    expect(workload?.data.warnings[0].tone).toBe("warning");
    expect(workload?.data.days.find((d) => d.dateKey === addDaysToKey(TODAY, 1))?.overloaded).toBe(true);
    expect(layout.calm).toBe(false);
    // The workload section shows the week, so the outlook steps aside.
    expect(kinds(layout)).not.toContain("week_outlook");
  });

  it("keeps a warning the conversation already raised as a fact, without a second offer", () => {
    const overload = rec({ kind: "overload_week", title: "This week is over capacity" });
    const { layout } = scenario({ recommendations: [overload], chatShownIds: [overload.id], tasks: [task({ title: "x" })] });
    const workload = section(layout, "workload");
    expect(workload?.data.warnings).toEqual([]);
    expect(workload?.data.coveredWarnings).toEqual([{ id: overload.id, message: "This week is over capacity" }]);
  });
});

describe("adaptive Home: nothing urgent", () => {
  const calmTasks = [task({ title: "Practice piano scales" }), task({ title: "Plan science fair", dueAt: due(10) })];

  it("never shows a warning or artificial urgency", () => {
    const { layout } = scenario({ tasks: calmTasks, goals: [goal("Run a 5K")] });
    expect(layout.calm).toBe(true);
    for (const k of WARNING_KINDS) expect(kinds(layout)).not.toContain(k);
    expect(kinds(layout)).not.toContain("deadlines");
    expect(layout.sections.some((s) => s.lead)).toBe(false);
  });

  it("offers open time with real goals and undated tasks, and a weekly outlook", () => {
    const { layout } = scenario({ tasks: calmTasks, goals: [goal("Run a 5K")] });
    const open = section(layout, "open_time");
    expect(open?.data.ideas.map((i) => i.title)).toEqual(["Run a 5K", "Practice piano scales"]);
    expect(open?.data.freeMinutes).toBeGreaterThanOrEqual(60);
    expect(kinds(layout)).toContain("week_outlook");
    expect(kinds(layout)).toContain("coming_up");
  });

  it("shows progress when the user finished things this week", () => {
    const done = task({ title: "Spanish vocab", status: "done", completedAt: zonedToUtc(TODAY, "10:00", TZ).toISOString() });
    const { layout } = scenario({ tasks: calmTasks, recentlyDone: [done] });
    expect(section(layout, "progress")?.data).toMatchObject({ doneToday: 1, doneThisWeek: 1 });
  });
});

describe("adaptive Home: new user", () => {
  it("gets one intentional getting-started section and nothing else", () => {
    const { layout } = scenario({ events: [], tasks: [] });
    expect(kinds(layout)).toEqual(["getting_started"]);
    expect(layout.calm).toBe(true);
  });

  it("with only a weekly routine, still gets a useful, quiet Home", () => {
    const { layout } = scenario({ events: weekCalendar(), tasks: [] });
    expect(kinds(layout)).not.toContain("getting_started");
    expect(kinds(layout)).toContain("week_outlook");
    for (const k of WARNING_KINDS) expect(kinds(layout)).not.toContain(k);
  });
});

describe("adaptive Home: rules", () => {
  const busy = () => ({
    tasks: [
      task({ title: "Overdue", dueAt: due(-1) }),
      task({ title: "Today", dueAt: due(0) }),
      task({ title: "Later", dueAt: due(9) }),
    ],
    recommendations: [
      rec({ kind: "overload_week", title: "Too much" }),
      rec({ kind: "postponed", title: "Moved twice" }),
    ],
    goals: [goal("A")],
    recentlyDone: [task({ title: "Done", status: "done", completedAt: NOW.toISOString() })],
  });

  it("caps each layer and keeps a fixed slot order", () => {
    const { layout } = scenario(busy());
    const adaptive = layout.sections.filter((s) => s.layer === "adaptive");
    const context = layout.sections.filter((s) => s.layer === "context");
    expect(adaptive.length).toBeLessThanOrEqual(MAX_ADAPTIVE);
    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT);
    const slots = layout.sections.map((s) => SLOTS[s.kind].slot);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(layout.sections.filter((s) => s.lead)).toHaveLength(1);
    for (const s of layout.sections) expect(s.reason.length).toBeGreaterThan(0);
  });

  it("is deterministic: same data, same sections, same order", () => {
    const data = busy();
    const a = scenario(data).layout;
    const b = scenario(data).layout;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("does not depend on the order data arrives in", () => {
    const data = busy();
    const a = scenario(data).layout;
    const b = scenario({ ...data, tasks: [...data.tasks].reverse() }).layout;
    expect(kinds(b)).toEqual(kinds(a));
    expect(section(b, "deadlines")?.data.items.map((i) => i.id)).toEqual(section(a, "deadlines")?.data.items.map((i) => i.id));
  });

  it("distinguishes commitments from suggestions", () => {
    const { layout } = scenario(busy());
    for (const i of section(layout, "deadlines")?.data.items ?? []) expect(["task", "calendar"]).toContain(i.source);
    for (const w of section(layout, "workload")?.data.warnings ?? []) expect(w.chips.some((c) => c.act.kind === "dismiss")).toBe(true);
  });
});

describe("adaptive Home: reliability", () => {
  it("works without the engine (failed or not set up)", () => {
    const { layout } = scenario({ tasks: [task({ title: "Essay", dueAt: due(1) })], engine: false });
    expect(kinds(layout)).toEqual(["deadlines"]);
    expect(section(layout, "deadlines")?.data.items[0].title).toBe("Essay");
  });

  it("works when optional sources (goals, finished tasks) failed to load", () => {
    expect(() => scenario({ tasks: [task({ title: "x" })], goals: null, recentlyDone: null })).not.toThrow();
  });

  it("ignores malformed dates instead of crashing", () => {
    const { layout } = scenario({ tasks: [task({ title: "Bad", dueAt: "not a date" }), task({ title: "Bad done", status: "done", completedAt: "nope" })], recentlyDone: [task({ title: "Bad done", status: "done", completedAt: "nope" })] });
    expect(section(layout, "deadlines")).toBeUndefined();
    expect(section(layout, "progress")).toBeUndefined();
  });
});
