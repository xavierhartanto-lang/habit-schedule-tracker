import { describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ getAiClient: vi.fn(), fallbackParams: () => ({}) }));
import { fromWire, normalizeUrl } from "../bell-lookup";

const wire = {
  found: true,
  confidence: "high" as const,
  schoolName: "Lincoln High School",
  rotation: "same" as const,
  dayTypes: [
    {
      label: "Regular",
      days: ["mo", "tu", "we", "th", "fr"] as ("mo" | "tu" | "we" | "th" | "fr")[],
      periods: [
        { label: "Period 1", start: "08:00", end: "08:50", kind: "class" as const },
        { label: "Lunch", start: "11:30", end: "12:00", kind: "lunch" as const },
      ],
    },
  ],
  sourceUrls: ["https://lincoln.example.org/bell-schedule/"],
  caveat: "",
};

describe("fromWire", () => {
  const seen = new Set([normalizeUrl("https://lincoln.example.org/bell-schedule")]);

  it("accepts a sourced, high-confidence schedule", () => {
    const r = fromWire(wire, seen);
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.schedule.source).toBe("lookup");
      expect(r.sources).toEqual(["https://lincoln.example.org/bell-schedule/"]);
    }
  });

  it("drops URLs the search never returned", () => {
    expect(fromWire(wire, new Set()).found).toBe(false);
  });

  it("drops low confidence", () => {
    expect(fromWire({ ...wire, confidence: "low" }, seen).found).toBe(false);
  });

  it("drops schedules that don't add up", () => {
    const bad = { ...wire, dayTypes: [{ ...wire.dayTypes[0], periods: [{ label: "P1", start: "9:00", end: "08:00", kind: "class" as const }] }] };
    expect(fromWire(bad, seen).found).toBe(false);
  });

  it("keeps a weekday on the first day type only", () => {
    const two = { ...wire, dayTypes: [wire.dayTypes[0], { ...wire.dayTypes[0], label: "Late", days: ["we" as const] }] };
    const r = fromWire(two, seen);
    expect(r.found).toBe(true);
    if (r.found) expect(r.schedule.dayTypes[1].days).toEqual([]);
  });
});
