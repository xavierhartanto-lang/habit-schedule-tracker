import { describe, expect, it } from "vitest";
import { describeResult, preselected } from "../plan-card";
import type { PlanItem } from "../plan-types";

function item(status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem {
  return {
    id: status, position: 0, action: "remove_task", group: "organize", status, autoApplied: false, title: "Outline the Essay", detail: null, lifeAreaId: null,
    timing: null, previous: null, reason: null, tradeoffs: [], conflicts: [], warnings: [], chips: [], nearby: [], deadline: null, step: null,
    editable: false, canUndo: false, targetId: null, resultId: null, error: null, ...extra,
  };
}

describe("plan card state", () => {
  it("leaves failed items unticked so Approve all can't loop on them", () => {
    expect(preselected(item("pending"))).toBe(true);
    expect(preselected(item("conflict"))).toBe(true);
    expect(preselected(item("failed", { error: "Task not found" }))).toBe(false);
    expect(preselected(item("applied"))).toBe(false);
  });

  it("says nothing changed instead of 'Approved 0'", () => {
    expect(describeResult({ ok: true, plan: null as never, results: [] }, "approve")).toEqual({ tone: "warn", text: "Nothing changed." });
  });

  it("counts what actually applied and what failed", () => {
    const text = describeResult(
      {
        ok: true,
        plan: null as never,
        results: [
          { itemId: "a", outcome: "applied" },
          { itemId: "b", outcome: "applied" },
          { itemId: "c", outcome: "failed", message: "Task not found" },
        ],
      },
      "approve",
    ).text;
    expect(text).toBe("Approved 2. 1 couldn't be saved.");
  });
});
