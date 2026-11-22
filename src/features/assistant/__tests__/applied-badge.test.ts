import { describe, expect, it } from "vitest";

import { appliedBadge } from "../plan-card";

describe("finished card badge", () => {
  it("says what happened, not a blanket 'Added'", () => {
    expect(appliedBadge([{ action: "remove_event", status: "applied" }])).toBe("Removed");
    expect(appliedBadge([{ action: "create_event", status: "applied" }, { action: "schedule_block", status: "applied" }])).toBe("Added");
    expect(appliedBadge([{ action: "create_event", status: "applied" }, { action: "remove_event", status: "applied" }])).toBe("Done");
  });
});
