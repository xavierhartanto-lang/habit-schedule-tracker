import { describe, expect, it } from "vitest";
import type { Commitment } from "@/lib/domain/types";
import { layoutDay } from "../layout";
import { buildRRule, describeRecurrence, expandEvent, findConflicts, parseRRule } from "../recurrence";
import { dateKeyInZone, timeKeyInZone, zonedToUtc } from "../zoned";

const TZ = "America/Los_Angeles";

function event(partial: Partial<Commitment> & { startsAt: string; endsAt: string }): Commitment {
  return {
    id: partial.id ?? "e1",
    title: partial.title ?? "Practice",
    area: null,
    lifeAreaId: null,
    kind: partial.kind ?? "fixed",
    timezone: TZ,
    allDay: false,
    recurrenceExceptions: [],
    ...partial,
  };
}

const at = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString();
const range = (from: string, to: string) => [zonedToUtc(from, "00:00", TZ), zonedToUtc(to, "00:00", TZ)] as const;

describe("parseRRule / buildRRule", () => {
  it("round-trips the supported subset", () => {
    for (const rule of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
      "FREQ=MONTHLY;COUNT=6",
      "FREQ=YEARLY;UNTIL=20301231",
    ]) {
      expect(buildRRule(parseRRule(rule)!)).toBe(rule);
    }
  });

  it("accepts UNTIL with a time and the Phase 2 weekly format", () => {
    expect(parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z")?.until).toBe("2026-12-31");
  });

  it("refuses rules it cannot honor exactly", () => {
    expect(parseRRule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR")).toBeNull();
    expect(parseRRule("FREQ=HOURLY")).toBeNull();
    expect(parseRRule("FREQ=DAILY;COUNT=2;UNTIL=20270101")).toBeNull();
    expect(parseRRule("FREQ=DAILY;INTERVAL=0")).toBeNull();
  });

  it("describes rules in plain words", () => {
    expect(describeRecurrence(parseRRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")!)).toBe("Every week on weekdays");
    expect(describeRecurrence(parseRRule("FREQ=DAILY;COUNT=3")!)).toBe("Daily, 3 times");
  });
});

describe("expandEvent", () => {
  it("returns a one-off event only when it overlaps the window", () => {
    const e = event({ startsAt: at("2026-11-18", "16:00"), endsAt: at("2026-11-18", "18:00") });
    expect(expandEvent(e, ...range("2026-11-18", "2026-11-19"), TZ)).toHaveLength(1);
    expect(expandEvent(e, ...range("2026-11-19", "2026-11-20"), TZ)).toHaveLength(0);
  });

  it("repeats weekly on chosen days at the same local time across DST", () => {
    // Starts before the Nov 1 2026 DST change in Los Angeles.
    const e = event({
      startsAt: at("2026-10-26", "16:00"),
      endsAt: at("2026-10-26", "18:00"),
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE",
    });
    const occ = expandEvent(e, ...range("2026-10-26", "2026-11-09"), TZ);
    expect(occ.map((o) => o.date)).toEqual(["2026-10-26", "2026-10-28", "2026-11-02", "2026-11-04"]);
    for (const o of occ) expect(timeKeyInZone(o.start, TZ)).toBe("16:00");
    // Two hours long on both sides of the change.
    for (const o of occ) expect(o.end.getTime() - o.start.getTime()).toBe(2 * 3_600_000);
  });

  it("honors INTERVAL, COUNT, UNTIL and skipped dates", () => {
    const base = { startsAt: at("2026-11-02", "08:00"), endsAt: at("2026-11-02", "09:00") };
    const biweekly = event({ ...base, recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
    expect(expandEvent(biweekly, ...range("2026-11-01", "2026-12-01"), TZ).map((o) => o.date)).toEqual([
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);

    const counted = event({ ...base, recurrenceRule: "FREQ=DAILY;COUNT=3", recurrenceExceptions: ["2026-11-03"] });
    // COUNT counts the skipped date, as in RFC 5545.
    expect(expandEvent(counted, ...range("2026-11-01", "2026-12-01"), TZ).map((o) => o.date)).toEqual([
      "2026-11-02",
      "2026-11-04",
    ]);

    const until = event({ ...base, recurrenceRule: "FREQ=DAILY;UNTIL=20261104" });
    expect(expandEvent(until, ...range("2026-11-01", "2026-12-01"), TZ)).toHaveLength(3);
  });

  it("finds occurrences far from the series start without COUNT", () => {
    const e = event({ startsAt: at("2024-01-01", "07:00"), endsAt: at("2024-01-01", "07:30"), recurrenceRule: "FREQ=DAILY" });
    const occ = expandEvent(e, ...range("2026-11-18", "2026-11-19"), TZ);
    expect(occ).toHaveLength(1);
    expect(occ[0].date).toBe("2026-11-18");
  });

  it("skips months without the start day for monthly events", () => {
    const e = event({ startsAt: at("2026-01-31", "10:00"), endsAt: at("2026-01-31", "11:00"), recurrenceRule: "FREQ=MONTHLY" });
    const dates = expandEvent(e, ...range("2026-01-01", "2026-06-01"), TZ).map((o) => o.date);
    expect(dates).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("expands all-day events as whole local days", () => {
    const e = event({
      allDay: true,
      startsAt: at("2026-11-20", "00:00"),
      endsAt: at("2026-11-22", "00:00"),
      recurrenceRule: "FREQ=WEEKLY",
    });
    const occ = expandEvent(e, ...range("2026-11-20", "2026-12-01"), TZ);
    expect(occ.map((o) => o.date)).toEqual(["2026-11-20", "2026-11-27"]);
    expect(dateKeyInZone(occ[1].end, TZ)).toBe("2026-11-29");
    expect(occ[1].allDay).toBe(true);
  });
});

describe("conflicts and layout", () => {
  const a = event({ id: "a", title: "Class", startsAt: at("2026-11-18", "09:00"), endsAt: at("2026-11-18", "10:00") });
  const b = event({ id: "b", title: "Study", startsAt: at("2026-11-18", "09:30"), endsAt: at("2026-11-18", "11:00") });
  const c = event({ id: "c", title: "Lunch", startsAt: at("2026-11-18", "11:00"), endsAt: at("2026-11-18", "12:00") });
  const allDay = event({ id: "d", title: "Trip", allDay: true, startsAt: at("2026-11-18", "00:00"), endsAt: at("2026-11-19", "00:00") });
  const occ = [a, b, c, allDay].flatMap((e) => expandEvent(e, ...range("2026-11-18", "2026-11-19"), TZ));

  it("flags overlapping timed events, not touching or all-day ones", () => {
    const conflicts = findConflicts(occ);
    expect(conflicts.get("a:2026-11-18")).toEqual(["Study"]);
    expect(conflicts.get("b:2026-11-18")).toEqual(["Class"]);
    expect(conflicts.has("c:2026-11-18")).toBe(false);
    expect(conflicts.has("d:2026-11-18")).toBe(false);
  });

  it("puts overlapping events side by side", () => {
    const placed = layoutDay(occ, "2026-11-18", TZ);
    const byId = Object.fromEntries(placed.map((p) => [p.occ.event.id, p]));
    expect(byId.a.columns).toBe(2);
    expect(byId.b.column).toBe(1);
    expect(byId.c.columns).toBe(1);
    expect(byId.a.startMin).toBe(9 * 60);
    expect(byId.d).toBeUndefined();
  });

  it("clips events that cross midnight", () => {
    const late = event({ id: "n", startsAt: at("2026-11-18", "23:00"), endsAt: at("2026-11-19", "01:00") });
    const o = expandEvent(late, ...range("2026-11-18", "2026-11-20"), TZ);
    expect(layoutDay(o, "2026-11-18", TZ)[0]).toMatchObject({ startMin: 1380, endMin: 1440, clippedEnd: true });
    expect(layoutDay(o, "2026-11-19", TZ)[0]).toMatchObject({ startMin: 0, endMin: 60, clippedStart: true });
  });
});
