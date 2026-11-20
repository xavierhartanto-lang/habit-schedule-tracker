import { describe, expect, it } from "vitest";
import {
  addMonthsToKey,
  dateKeyInZone,
  isDateKey,
  isValidTimeZone,
  monthGridKeys,
  rezoneWallClock,
  startOfWeekKey,
  timeKeyInZone,
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

describe("rezoneWallClock", () => {
  const LA = "America/Los_Angeles";
  it("keeps the wall clock time when moving a UTC-saved event to the user's zone", () => {
    // "Debate Saturday 9-11 AM" saved while the profile was UTC showed as 1-3 AM in Los Angeles.
    const start = rezoneWallClock("2026-11-21T09:00:00.000Z", "UTC", LA);
    expect(start).toBe("2026-11-21T17:00:00.000Z");
    expect(timeKeyInZone(new Date(start), LA)).toBe("09:00");
    expect(dateKeyInZone(new Date(start), LA)).toBe("2026-11-21");
  });

  it("uses the offset of the event's own date across daylight saving", () => {
    // October is PDT (UTC-7), not PST.
    expect(rezoneWallClock("2026-10-15T14:10:00.000Z", "UTC", LA)).toBe("2026-10-15T21:10:00.000Z");
  });

  it("keeps late-evening times on the same local day", () => {
    // A date-only due date is 23:59 local; saved as UTC it showed as 3:59 PM.
    const due = rezoneWallClock("2026-11-19T23:59:00.000Z", "UTC", LA);
    expect(dateKeyInZone(new Date(due), LA)).toBe("2026-11-19");
    expect(timeKeyInZone(new Date(due), LA)).toBe("23:59");
  });
});
