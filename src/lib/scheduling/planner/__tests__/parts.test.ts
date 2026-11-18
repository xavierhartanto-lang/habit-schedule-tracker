import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/domain/types";
import { mergeIntervals, subtractIntervals } from "../intervals";
import { evenSplit } from "../requests";
import {
  DEFAULT_SCHEDULING_PREFERENCES,
  defaultSchedulingPreferences,
  planRequestSchema,
  requestFromTask,
  schedulingPreferencesSchema,
  sessionSizes,
} from "..";

describe("intervals", () => {
  it("merges and subtracts", () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 9 }])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 8, end: 12 }, { start: -5, end: 1 }])).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 8 },
    ]);
  });
});

describe("session sizes", () => {
  const prefs = { minSessionMinutes: 30, maxSessionMinutes: 90 };
  it("splits total time into even sessions under the max", () => {
    expect(sessionSizes({ type: "total", minutes: 180 }, prefs)).toEqual([90, 90]);
    expect(sessionSizes({ type: "total", minutes: 200 }, prefs)).toEqual([70, 65, 65]);
    expect(sessionSizes({ type: "total", minutes: 45 }, prefs)).toEqual([45]);
    expect(sessionSizes({ type: "single", minutes: 240 }, prefs)).toEqual([240]);
    expect(sessionSizes({ type: "sessions", count: 3, minutesEach: 40 }, prefs)).toEqual([40, 40, 40]);
  });
  it("respects the minimum when min and max are close", () => {
    expect(sessionSizes({ type: "total", minutes: 100 }, { minSessionMinutes: 60, maxSessionMinutes: 90 })).toEqual([100]);
  });
  it("splits evenly in 5-minute steps", () => {
    expect(evenSplit(75, 2)).toEqual([40, 35]);
    expect(evenSplit(61, 2)).toEqual([31, 30]);
  });
});

describe("preferences", () => {
  it("builds defaults from the user's day bounds", () => {
    const p = defaultSchedulingPreferences({ dayStartTime: "08:00", dayEndTime: "22:00" });
    expect(p.workingHours.mo).toEqual([{ start: "15:30", end: "21:30" }]);
    expect(p.workingHours.sa).toEqual([{ start: "09:00", end: "21:30" }]);
    expect(schedulingPreferencesSchema.safeParse(p).success).toBe(true);
    expect(schedulingPreferencesSchema.safeParse(DEFAULT_SCHEDULING_PREFERENCES).success).toBe(true);
  });
  it("handles short or odd day bounds", () => {
    const p = defaultSchedulingPreferences({ dayStartTime: "14:00", dayEndTime: "16:00" });
    expect(schedulingPreferencesSchema.safeParse(p).success).toBe(true);
    expect(defaultSchedulingPreferences({ dayStartTime: "bad", dayEndTime: "07:00" }).workingHours.mo[0].end).toBe("22:00");
  });
  it("rejects invalid settings with readable messages", () => {
    const bad = (patch: object) => schedulingPreferencesSchema.safeParse({ ...DEFAULT_SCHEDULING_PREFERENCES, ...patch });
    expect(bad({ bufferMinutes: 90 }).error?.issues[0].message).toBe("Buffer must be at most 60.");
    expect(bad({ minSessionMinutes: 100, maxSessionMinutes: 60 }).success).toBe(false);
    expect(bad({ workingHours: { ...DEFAULT_SCHEDULING_PREFERENCES.workingHours, mo: [{ start: "18:00", end: "17:00" }] } }).success).toBe(false);
    expect(bad({ protectedTimes: [{ label: " ", days: ["mo"], start: "18:00", end: "19:00" }] }).success).toBe(false);
    expect(bad({ protectedTimes: [{ label: "Sleep", days: ["su", "mo"], start: "23:00", end: "07:00" }] }).data?.protectedTimes[0].days).toEqual(["mo", "su"]);
  });
});

describe("requests", () => {
  it("validates AI output strictly", () => {
    expect(planRequestSchema.safeParse({ id: "a", title: "Piano", amount: { type: "sessions", count: 2, minutesEach: 30 } }).success).toBe(true);
    expect(planRequestSchema.safeParse({ id: "a", title: "Piano", amount: { type: "sessions", count: 2 } }).success).toBe(false);
    expect(planRequestSchema.safeParse({ id: "a", title: "Piano", amount: { type: "total", minutes: 30.5 } }).success).toBe(false);
    expect(planRequestSchema.safeParse({ id: "a", title: "", amount: { type: "single", minutes: 30 } }).success).toBe(false);
    expect(planRequestSchema.safeParse({ id: "a", title: "X", amount: { type: "single", minutes: 30 }, deadline: "next friday" }).success).toBe(false);
  });

  it("turns open tasks with an estimate into requests", () => {
    const task: Task = { id: "t1", title: "Lab report", area: null, priority: "high", status: "todo", dueAt: "2026-11-27T07:59:00.000Z", estimatedMinutes: 120, goalId: "g1", lifeAreaId: "la" };
    expect(requestFromTask(task)).toEqual({
      id: "task:t1",
      title: "Lab report",
      amount: { type: "total", minutes: 120 },
      priority: "high",
      deadline: "2026-11-27T07:59:00.000Z",
      lifeAreaId: "la",
      taskId: "t1",
      goalId: "g1",
    });
    expect(requestFromTask({ ...task, estimatedMinutes: null })).toBeNull();
    expect(requestFromTask({ ...task, status: "done" })).toBeNull();
  });
});
