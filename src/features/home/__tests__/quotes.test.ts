import { describe, expect, it } from "vitest";
import { QUOTES, quoteForDay } from "../quotes";

describe("quoteForDay", () => {
  it("is stable for a day and changes the next day", () => {
    expect(quoteForDay("2026-11-21")).toBe(quoteForDay("2026-11-21"));
    expect(quoteForDay("2026-11-22")).not.toBe(quoteForDay("2026-11-21"));
  });

  it("visits every quote before repeating", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= QUOTES.length; i++) {
      const d = new Date(Date.UTC(2027, 0, i)).toISOString().slice(0, 10);
      seen.add(quoteForDay(d).text);
    }
    expect(seen.size).toBe(QUOTES.length);
  });

  it("keeps quotes short enough for one calm line", () => {
    for (const q of QUOTES) expect(q.text.length).toBeLessThanOrEqual(110);
  });
});
