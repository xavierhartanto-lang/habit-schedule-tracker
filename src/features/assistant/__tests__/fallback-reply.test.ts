import { describe, expect, it } from "vitest";

import { fallbackReply } from "../fallback-reply";
import type { PlanItem, PlanView } from "../plan-types";

const item = (status: PlanItem["status"]): PlanItem => ({ status } as PlanItem);
const plan = (items: PlanItem[], unscheduled: PlanView["unscheduled"] = []): PlanView =>
  ({ id: "p", items, unscheduled } as unknown as PlanView);

describe("fallbackReply", () => {
  it("points to the approval card", () => {
    expect(fallbackReply({ plan: plan([item("pending")]), failed: null })).toBe(
      "Here's what I'd suggest. Nothing changes until you approve it below.",
    );
    expect(fallbackReply({ plan: plan([item("pending"), item("conflict")]), failed: null })).toMatch(/^Here are 2 changes/);
  });

  it("is honest about what didn't fit", () => {
    const text = fallbackReply({ plan: plan([], [{ title: "History essay", minutes: 45, reason: "No free time" }]), failed: null });
    expect(text).toContain("nothing is waiting for approval");
    expect(text).toContain("History essay (45 min short)");
  });

  it("says nothing changed on failure", () => {
    expect(fallbackReply({ plan: null, failed: "That suggestion is no longer available." })).toBe(
      "That suggestion is no longer available. Nothing on your calendar changed.",
    );
  });
});
