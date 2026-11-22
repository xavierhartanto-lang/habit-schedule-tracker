import { describe, expect, it } from "vitest";
import { validateEventForm, type EventForm } from "../events";
import { validateGoalInput } from "../goals";
import { cadenceLabel, completionRate, isScheduledOn, validateHabitForm, weekProgress } from "../habits";
import { areaOf, validateLifeAreaInput } from "../life-areas";
import { dueBucket, filterTasks, nextRepeatDate, nextRepeatDue, sortTasks, validateTaskForm, DEFAULT_TASK_FILTER } from "../tasks";
import type { LifeAreaRecord, Task } from "../types";
import { zonedToUtc } from "@/lib/scheduling/zoned";

const TZ = "America/Los_Angeles";
const AREA = "11111111-1111-4111-8111-111111111111";

function form(patch: Partial<EventForm> = {}): EventForm {
  return {
    title: "Swim practice",
    description: null,
    location: null,
    lifeAreaId: AREA,
    kind: "fixed",
    allDay: false,
    startDate: "2026-11-18",
    startTime: "16:00",
    endDate: "2026-11-18",
    endTime: "18:00",
    timezone: TZ,
    repeat: { freq: "NONE", interval: 1, byDay: [], ends: "never", until: null, count: null },
    ...patch,
  };
}

describe("validateEventForm", () => {
  it("converts local times to UTC", () => {
    const r = validateEventForm(form());
    expect(r.ok && r.value).toMatchObject({
      startsAt: "2026-11-19T00:00:00.000Z",
      endsAt: "2026-11-19T02:00:00.000Z",
      recurrenceRule: null,
      allDay: false,
    });
  });

  it("stores all-day events as local midnight to midnight", () => {
    const r = validateEventForm(form({ allDay: true, endDate: "2026-11-19" }));
    expect(r.ok && r.value).toMatchObject({ startsAt: "2026-11-18T08:00:00.000Z", endsAt: "2026-11-20T08:00:00.000Z" });
  });

  it("builds repeat rules", () => {
    const r = validateEventForm(
      form({ repeat: { freq: "WEEKLY", interval: 1, byDay: ["we", "mo"], ends: "count", until: null, count: 10 } }),
    );
    expect(r.ok && r.value.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10");
  });

  it("rejects bad input with readable errors", () => {
    expect(validateEventForm(form({ title: "   " }))).toEqual({ ok: false, error: "A title is required." });
    expect(validateEventForm(form({ endTime: "15:00" })).ok).toBe(false);
    expect(validateEventForm(form({ timezone: "Nowhere/City" })).ok).toBe(false);
    expect(validateEventForm(form({ lifeAreaId: "not-a-uuid" })).ok).toBe(false);
    expect(
      validateEventForm(form({ repeat: { freq: "WEEKLY", interval: 1, byDay: [], ends: "never", until: null, count: null } })).ok,
    ).toBe(false);
    expect(validateEventForm(form({ endDate: "2027-02-01" })).ok).toBe(false);
  });
});

describe("tasks", () => {
  it("validates and converts due dates", () => {
    const r = validateTaskForm({ title: "Lab report", dueDate: "2026-11-20", timezone: TZ });
    expect(r.ok && r.value).toMatchObject({ priority: "medium", status: "todo", dueAt: "2026-11-21T07:59:00.000Z" });
    expect(validateTaskForm({ title: "x", estimatedMinutes: 0, timezone: TZ }).ok).toBe(false);
    expect(validateTaskForm({ title: "x", dueTime: "10:00", timezone: TZ }).ok).toBe(false);
    expect(validateTaskForm({ title: "x", priority: "urgent", timezone: TZ }).ok).toBe(false);
    expect(validateTaskForm({ title: "x", repeat: "hourly", timezone: TZ }).ok).toBe(false);
  });

  it("repeats from the day you check it off, and finishing it for good stops the repeat", () => {
    const open = validateTaskForm({ title: "Check school assignments", repeat: "daily", timezone: TZ });
    expect(open.ok && open.value.repeat).toBe("daily");
    const done = validateTaskForm({ title: "Check school assignments", repeat: "daily", status: "done", timezone: TZ });
    expect(done.ok && done.value).toMatchObject({ status: "done", repeat: null });

    // Wednesday the 18th.
    expect(nextRepeatDate("daily", "2026-11-18")).toBe("2026-11-19");
    expect(nextRepeatDate("weekly", "2026-11-18")).toBe("2026-11-25");
    expect(nextRepeatDate("weekdays", "2026-11-18")).toBe("2026-11-19");
    expect(nextRepeatDate("weekdays", "2026-11-20")).toBe("2026-11-23");
    expect(nextRepeatDate("weekdays", "2026-11-21")).toBe("2026-11-23");
    expect(nextRepeatDate("monthly", "2026-01-31")).toBe("2026-02-28");
    expect(nextRepeatDue("daily", "2026-11-18", null, TZ)).toBe("2026-11-20T07:59:00.000Z");
    expect(nextRepeatDue("weekly", "2026-11-18", zonedToUtc("2026-11-18", "15:00", TZ).toISOString(), TZ)).toBe(
      zonedToUtc("2026-11-25", "15:00", TZ).toISOString(),
    );
  });

  const t = (id: string, patch: Partial<Task>): Task => ({
    id,
    title: id,
    area: null,
    lifeAreaId: null,
    priority: "medium",
    status: "todo",
    dueAt: null,
    estimatedMinutes: null,
    createdAt: `2026-11-0${id.length}T00:00:00Z`,
    ...patch,
  });
  const tasks = [
    t("a", { priority: "low", dueAt: "2026-11-17T20:00:00Z" }),
    t("bb", { priority: "high", dueAt: "2026-11-25T20:00:00Z", lifeAreaId: AREA }),
    t("ccc", { status: "done" }),
    t("dddd", { priority: "high", estimatedMinutes: 15 }),
  ];
  const ctx = { todayKey: "2026-11-18", timeZone: TZ };

  it("buckets due dates", () => {
    expect(dueBucket(tasks[0], ctx.todayKey, TZ)).toBe("overdue");
    expect(dueBucket(tasks[1], ctx.todayKey, TZ)).toBe("later");
    expect(dueBucket(tasks[3], ctx.todayKey, TZ)).toBe("none");
  });

  it("filters and sorts", () => {
    expect(filterTasks(tasks, DEFAULT_TASK_FILTER, ctx).map((x) => x.id)).toEqual(["a", "bb", "dddd"]);
    expect(filterTasks(tasks, { ...DEFAULT_TASK_FILTER, area: AREA }, ctx).map((x) => x.id)).toEqual(["bb"]);
    expect(filterTasks(tasks, { ...DEFAULT_TASK_FILTER, area: "none", due: "overdue" }, ctx).map((x) => x.id)).toEqual(["a"]);
    expect(sortTasks(tasks, "priority").map((x) => x.id)).toEqual(["bb", "dddd", "a", "ccc"]);
    expect(sortTasks(tasks, "due").map((x) => x.id)).toEqual(["a", "bb", "dddd", "ccc"]);
    expect(sortTasks(tasks, "duration")[0].id).toBe("dddd");
  });
});

describe("habits", () => {
  it("validates frequency", () => {
    expect(validateHabitForm({ title: "Read", cadence: { type: "specific_days", days: ["fr", "mo"] } })).toMatchObject({
      ok: true,
      value: { cadence: { type: "specific_days", days: ["mo", "fr"] } },
    });
    expect(validateHabitForm({ title: "Read", cadence: { type: "weekly", timesPerWeek: 9 } }).ok).toBe(false);
    expect(validateHabitForm({ title: "Read", cadence: { type: "specific_days", days: [] } }).ok).toBe(false);
  });

  it("knows which days are planned", () => {
    const c = { type: "specific_days" as const, days: ["mo" as const, "we" as const] };
    expect(isScheduledOn(c, "2026-11-16")).toBe(true);
    expect(isScheduledOn(c, "2026-11-17")).toBe(false);
    expect(cadenceLabel(c)).toBe("Mon, Wed");
  });

  it("measures progress as a rate, not a streak", () => {
    const habit = { cadence: { type: "daily" as const }, completedOn: ["2026-11-16", "2026-11-18"] };
    expect(weekProgress(habit, "2026-11-18", 1)).toEqual({ done: 2, target: 7 });
    // Mon-Wed so far this week, habit created Monday: 2 of 3 days.
    expect(completionRate(habit, "2026-11-18", 4, 1, "2026-11-16")).toBe(67);
    const weekly = { cadence: { type: "weekly" as const, timesPerWeek: 3 }, completedOn: ["2026-11-09", "2026-11-10", "2026-11-11"] };
    expect(completionRate(weekly, "2026-11-15", 1, 1, "2026-11-09")).toBe(100);
  });
});

describe("goals and life areas", () => {
  it("accepts manual progress and an explicit area", () => {
    const r = validateGoalInput({ title: "Sub-20 5K", lifeAreaId: AREA, progress: 40 });
    expect(r.ok && r.value).toMatchObject({ lifeAreaId: AREA, progress: 40, area: null });
    expect(validateGoalInput({ title: "x", progress: 101 }).ok).toBe(false);
    // Phase 2 proposals still send the legacy enum.
    expect(validateGoalInput({ title: "x", area: "academics" }).ok).toBe(true);
  });

  it("validates life areas and resolves legacy categories", () => {
    expect(validateLifeAreaInput({ name: "  Debate  ", color: "teal" })).toEqual({ ok: true, value: { name: "Debate", color: "teal" } });
    expect(validateLifeAreaInput({ name: "", color: "teal" }).ok).toBe(false);
    expect(validateLifeAreaInput({ name: "X", color: "neon" }).ok).toBe(false);
    const areas: LifeAreaRecord[] = [{ id: AREA, name: "Sports", color: "green", position: 0, legacyKey: "athletics" }];
    expect(areaOf(areas, { area: "athletics" })?.name).toBe("Sports");
    expect(areaOf(areas, { lifeAreaId: AREA })?.name).toBe("Sports");
    expect(areaOf(areas, { area: "rest" })).toBeNull();
  });
});
