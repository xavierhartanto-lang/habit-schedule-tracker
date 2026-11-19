import { describe, expect, it } from "vitest";

import type { DailyBrief, ProactiveState, Recommendation } from "@/features/proactive/types";
import { homeProactive, shownIds, toNudge } from "../proactive";

const brief = (over: Partial<DailyBrief> = {}): DailyBrief => ({
  date: "2026-11-19",
  timeZone: "America/Los_Angeles",
  events: [],
  freeMinutes: 0,
  focus: [],
  message: "",
  action: null,
  ...over,
});

let n = 0;
const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  id: `00000000-0000-4000-8000-00000000000${++n}`,
  kind: "deadline_soon",
  priority: "medium",
  status: "open",
  title: "History essay is due tomorrow",
  reason: "Due tomorrow and nothing is scheduled.",
  message: "History essay is due tomorrow and nothing is scheduled yet. Want me to find time?",
  facts: ["Due Fri, Nov 20", "About 2 h of work"],
  target: { taskId: "task-1", commitmentIds: [], date: null },
  actions: [
    { id: "schedule_work", kind: "schedule_work", label: "Find time", params: { taskId: "task-1", minutes: 120 } },
    { id: "split", kind: "split_sessions", label: "Split into 2 sessions", params: { taskId: "task-1", sessions: 2, minutesEach: 60 } },
    { id: "complete", kind: "mark_complete", label: "It's done", params: { taskId: "task-1" } },
  ],
  dedupeKey: "k",
  planId: null,
  createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:00:00Z",
  lastShownAt: null,
  raisedRecently: false,
  ...over,
} as Recommendation);

const state = (over: Partial<ProactiveState> = {}): ProactiveState => ({
  settings: { proactivity: "balanced", quietHoursStart: null, quietHoursEnd: null },
  quiet: false,
  today: brief(),
  recommendations: [],
  openCount: 0,
  ...over,
});

const planDay = { id: "plan_day", kind: "plan_day" as const, label: "Organize my day", params: { date: "2026-11-19", taskIds: ["task-1"] } };

describe("homeProactive", () => {
  it("returns nothing when the engine has nothing", () => {
    const p = homeProactive(state(), true);
    expect(p.opening).toBeNull();
    expect(p.nudges).toEqual([]);
    expect(homeProactive(null, true).opening).toBeNull();
  });

  it("opens with the daily brief and its one button", () => {
    const p = homeProactive(
      state({ today: brief({ message: "You have Basketball at 5 PM. I'd start on History essay.", action: planDay }) }),
      true,
    );
    expect(p.opening?.message).toBe("You have Basketball at 5 PM. I'd start on History essay.");
    expect(p.opening?.chips).toEqual([{ label: "Organize my day", primary: true, act: { kind: "daily_plan" } }]);
    expect(p.opening?.recommendationId).toBeNull();
  });

  it("ignores a brief with nothing to plan", () => {
    const p = homeProactive(state({ today: brief({ message: "Your day is clear.", action: null }) }), true);
    expect(p.opening).toBeNull();
  });

  it("does not repeat a suggestion about a task the brief already covers", () => {
    const covered = rec({ target: { taskId: "task-1", commitmentIds: [], date: null } });
    const other = rec({ kind: "overload_day", target: { taskId: null, commitmentIds: ["c1"], date: "2026-11-21" } });
    const p = homeProactive(
      state({
        today: brief({ message: "Start on History essay.", action: planDay, focus: [{ taskId: "task-1", title: "History essay", dueAt: null, estimatedMinutes: 120, why: "Due tomorrow" }] }),
        recommendations: [covered, other],
      }),
      true,
    );
    expect(p.nudges.map((x) => x.id)).toEqual([other.id]);
    expect(p.nudges[0].tone).toBe("warning");
  });

  it("covered tasks don't use up the suggestion limit", () => {
    const focus = [
      { taskId: "a", title: "A", dueAt: null, estimatedMinutes: 60, why: "" },
      { taskId: "b", title: "B", dueAt: null, estimatedMinutes: 60, why: "" },
    ];
    const recs = [
      rec({ priority: "high", target: { taskId: "a", commitmentIds: [], date: null } }),
      rec({ priority: "high", target: { taskId: "b", commitmentIds: [], date: null } }),
      rec({ priority: "high", kind: "overload_day", target: { taskId: null, commitmentIds: [], date: "2026-11-20" } }),
    ];
    const p = homeProactive(state({ today: brief({ message: "Plan today.", action: planDay, focus }), recommendations: recs }), true);
    expect(p.nudges.map((x) => x.id)).toEqual([recs[2].id]);
  });

  it("stays quiet during quiet hours", () => {
    const p = homeProactive(
      state({ settings: { proactivity: "balanced", quietHoursStart: "00:00", quietHoursEnd: "23:59" }, recommendations: [rec({ priority: "high" })] }),
      true,
    );
    expect(p.opening).toBeNull();
    expect(p.nudges).toEqual([]);
  });

  it("leads with a fresh high-priority recommendation when there's no brief", () => {
    const top = rec({ priority: "high", kind: "overdue" });
    const second = rec({ priority: "medium" });
    const p = homeProactive(state({ recommendations: [top, second] }), true);
    expect(p.opening?.recommendationId).toBe(top.id);
    expect(p.opening?.chips.map((c) => c.label)).toEqual(["Find time", "Split into 2 sessions", "Not now"]);
    expect(p.opening?.chips[0].primary).toBe(true);
    expect(p.nudges.map((x) => x.id)).toEqual([second.id]);
    // Resumed conversation: the opening one comes back as a quiet line.
    expect(p.resumeNudges.map((x) => x.id)).toEqual([top.id, second.id]);
    expect(shownIds(p, false)).toEqual([top.id, second.id]);
  });

  it("never leads with something raised recently", () => {
    const old = rec({ priority: "high", raisedRecently: true });
    const p = homeProactive(state({ recommendations: [old] }), true);
    expect(p.opening).toBeNull();
    expect(p.nudges.map((x) => x.id)).toEqual([old.id]);
  });

  it("shows at most two quiet lines and skips non-open ones", () => {
    const recs = [rec(), rec(), rec(), rec({ status: "dismissed" })];
    const p = homeProactive(state({ recommendations: recs }), true);
    expect(p.nudges).toHaveLength(2);
  });
});

describe("toNudge", () => {
  it("hides free-form follow-ups when the AI is off, keeps plan buttons", () => {
    const r = rec({
      actions: [
        { id: "ask", kind: "ask", label: "Pick a new date", params: { prompt: "Help me pick a new due date for History essay." } },
        { id: "schedule_work", kind: "schedule_work", label: "Find time", params: {} },
      ],
    });
    expect(toNudge(r, false).chips.map((c) => c.label)).toEqual(["Find time", "Not now"]);
    const on = toNudge(r, true).chips;
    expect(on[0]).toEqual({ label: "Pick a new date", primary: true, act: { kind: "ask", prompt: "Help me pick a new due date for History essay." } });
  });

  it("always offers Not now, even with no actions", () => {
    expect(toNudge(rec({ actions: [] }), true).chips).toEqual([{ label: "Not now", act: { kind: "dismiss", id: expect.any(String) } }]);
  });
});
