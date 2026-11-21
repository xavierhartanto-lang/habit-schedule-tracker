import { describe, expect, it } from "vitest";
import type { PlanItem } from "../plan-types";
import { choosePlanVisual, factVisual, leftOutTag, parseDuration, stepGroup, stripWindow } from "../plan-visual";

const tz = "America/Los_Angeles";
const iso = (d: string, t: string) => new Date(`${d}T${t}:00-08:00`).toISOString();
function item(id: string, date: string, a: string, b: string, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    id, position: 0, action: "schedule_block", group: "calendar", status: "pending", autoApplied: false, title: id, detail: null, lifeAreaId: null,
    timing: { start: iso(date, a), end: iso(date, b), date, startTime: a, endTime: b, durationMinutes: 30, timeZone: tz, allDay: false, recurrence: null },
    previous: null, reason: null, tradeoffs: [], conflicts: [], warnings: [], chips: [], nearby: [], deadline: null, step: null,
    editable: true, canUndo: false, targetId: null, resultId: null, error: null, ...extra,
  };
}
const step = (currentId: string) => ({ parentId: "p", parentTitle: "Essay", currentId, steps: [{ id: "a", title: "A", dueAt: null }, { id: "b", title: "B", dueAt: null }] });

describe("choosePlanVisual", () => {
  it("one day of sessions is a day strip", () => {
    expect(choosePlanVisual([item("a", "2026-11-20", "18:00", "18:30"), item("b", "2026-11-20", "19:00", "19:30")])).toBe("day");
  });
  it("sessions over several days are week strips", () => {
    expect(choosePlanVisual([item("a", "2026-11-20", "18:00", "18:30"), item("b", "2026-11-22", "19:00", "19:30")])).toBe("week");
  });
  it("two steps of one bigger task are a step path", () => {
    const items = [item("a", "2026-11-20", "18:00", "18:30", { step: step("a") }), item("b", "2026-11-20", "19:00", "19:30", { step: step("b") })];
    expect(choosePlanVisual(items)).toBe("steps");
    expect(stepGroup(items)?.parentTitle).toBe("Essay");
  });
  it("tasks, habits and facts stay a compact list", () => {
    expect(choosePlanVisual([{ ...item("t", "2026-11-20", "18:00", "18:30"), action: "create_task", group: "organize", timing: null }])).toBe("list");
  });
  it("more than a week falls back to the list", () => {
    expect(choosePlanVisual([item("a", "2026-11-20", "18:00", "18:30"), item("b", "2026-12-05", "19:00", "19:30")])).toBe("list");
  });
});

describe("leftOutTag", () => {
  it("reads the planner's wording", () => {
    expect(leftOutTag({ title: "x", minutes: 0, reason: "No room left today. It's overdue, so it's first in line next." })).toEqual({ label: "Overdue · next up", tone: "danger" });
    expect(leftOutTag({ title: "x", minutes: 0, reason: "No room left today. Due today, and there's time before then." })).toEqual({ label: "Due today", tone: "warn" });
    expect(leftOutTag({ title: "x", minutes: 0, reason: "No room left today. Due Friday, and it's tight." })?.label).toBe("Tight · due Friday");
    expect(leftOutTag({ title: "x", minutes: 45, reason: "There isn't enough free time." })).toEqual({ label: "45m short", tone: "warn" });
    expect(leftOutTag({ title: "x", minutes: 0, reason: "Something new." })).toBeNull();
  });
});

describe("factVisual", () => {
  it("turns work and free time into a bar and keeps the rest as chips", () => {
    const v = factVisual(["Due Fri, Nov 20", "About 30 min of work left", "About 1 h 15 min free before then"]);
    expect(v.capacity).toEqual({ work: 30, free: 75 });
    expect(v.chips).toEqual([{ label: "Due Fri, Nov 20", kind: "due" }]);
  });
  it("without both numbers, no bar", () => {
    expect(factVisual(["About 2 h of work left"]).capacity).toBeNull();
    expect(parseDuration("2 h")).toBe(120);
  });
});

describe("stripWindow", () => {
  it("snaps to whole local hours, at least three wide, and reaches a nearby deadline", () => {
    const w = stripWindow([{ start: Date.parse(iso("2026-11-20", "18:10")), end: Date.parse(iso("2026-11-20", "18:55")) }], Date.parse(iso("2026-11-20", "23:59")), tz);
    expect(new Date(w.start).toISOString()).toBe(iso("2026-11-20", "18:00"));
    expect(new Date(w.end).toISOString()).toBe(new Date(`2026-11-21T00:00:00-08:00`).toISOString());
  });
});
