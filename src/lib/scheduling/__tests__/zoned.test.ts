import { describe, expect, it } from "vitest";
import {
  addMonthsToKey,
  dateKeyInZone,
  isDateKey,
  isValidTimeZone,
  monthGridKeys,
  startOfWeekKey,
  weekKeys,
  zonedToUtc,
} from "../zoned";

describe("zoned time helpers", () => {
  it("converts wall-clock time to UTC with DST", () => {
    expect(zonedToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedToUtc("2026-12-01", "09:00", "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(zonedToUtc("2026-12-01", "09:00", "Asia/Jakarta").toISOString()).toBe("2026-12-01T02:00:00.000Z");
  });

  it("reads the local date of an instant", () => {
    const instant = new Date("2026-11-19T03:00:00Z");
    expect(dateKeyInZone(instant, "America/Los_Angeles")).toBe("2026-11-18");
    expect(dateKeyInZone(instant, "Asia/Tokyo")).toBe("2026-11-19");
  });

  it("validates inputs", () => {
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });

  it("builds weeks and months", () => {
    expect(startOfWeekKey("2026-11-18", 1)).toBe("2026-11-16");
    expect(startOfWeekKey("2026-11-18", 0)).toBe("2026-11-15");
    expect(weekKeys("2026-11-18", 1)).toHaveLength(7);
    const grid = monthGridKeys("2026-11-18", 1);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-10-26");
    expect(addMonthsToKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToKey("2026-12-15", 1)).toBe("2027-01-15");
  });
});
