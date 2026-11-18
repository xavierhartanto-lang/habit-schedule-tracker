import { describe, expect, it } from "vitest";
import type { Commitment } from "@/lib/domain/types";
import { dateKeyInZone, timeKeyInZone, zonedToUtc } from "../../zoned";
import {
  DEFAULT_SCHEDULING_PREFERENCES,
  SchedulingInputError,
  checkPlacements,
  findFreeTime,
  planSchedule,
  type PlanInput,
  type PlanRequest,
  type SchedulingPreferences,
} from "..";

const TZ = "America/Los_Angeles";
const at = (date: string, time: string, tz = TZ) => zonedToUtc(date, time, tz).toISOString();

function event(id: string, title: string, date: string, start: string, end: string, rule?: string, extra: Partial<Commitment> = {}): Commitment {
  return {
    id,
    title,
    area: null,
    kind: "fixed",
    startsAt: at(date, start, extra.timezone ?? TZ),
    endsAt: at(date, end, extra.timezone ?? TZ),
    recurrenceRule: rule ?? null,
    ...extra,
  };
}

// Week of Mon 2026-11-23. School every weekday, volleyball every Thursday.
const SCHOOL = event("school", "School", "2026-11-02", "08:00", "15:00", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
const VOLLEYBALL = event("vb", "Volleyball", "2026-11-05", "18:00", "20:00", "FREQ=WEEKLY;BYDAY=TH");

const PREFS: SchedulingPreferences = {
  ...DEFAULT_SCHEDULING_PREFERENCES,
  workingHours: {
    mo: [{ start: "15:30", end: "21:30" }],
    tu: [{ start: "15:30", end: "21:30" }],
    we: [{ start: "15:30", end: "21:30" }],
    th: [{ start: "15:30", end: "21:30" }],
    fr: [{ start: "15:30", end: "21:30" }],
    sa: [{ start: "10:00", end: "18:00" }],
    su: [{ start: "10:00", end: "18:00" }],
  },
};

function base(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    now: at("2026-11-22", "20:00"),
    timeZone: TZ,
    window: { start: at("2026-11-23", "00:00"), end: at("2026-11-30", "00:00") },
    events: [SCHOOL, VOLLEYBALL],
    preferences: PREFS,
    requests: [],
    ...overrides,
  };
}

const req = (r: Partial<PlanRequest> & Pick<PlanRequest, "id" | "amount">): PlanRequest => ({ title: r.id, ...r });

function busyFrom(input: PlanInput) {
  return findFreeTime(input);
}

function local(iso: string, tz = TZ) {
  const d = new Date(iso);
  return `${dateKeyInZone(d, tz)} ${timeKeyInZone(d, tz)}`;
}

function assertNoOverlaps(result: ReturnType<typeof planSchedule>, input: PlanInput) {
  const check = checkPlacements(input, result.sessions.map((s) => ({ id: s.id, start: s.start, end: s.end, title: s.title })));
  expect(check.results.flatMap((r) => r.conflicts)).toEqual([]);
  expect(check.ok).toBe(true);
}

describe("findFreeTime", () => {
  it("returns working hours minus events, buffers and the past", () => {
    const free = busyFrom(base());
    const thursday = free.filter((f) => f.date === "2026-11-26").map((f) => [local(f.start), local(f.end)]);
    // Volleyball 6-8 PM with a 10-minute buffer either side.
    expect(thursday).toEqual([
      ["2026-11-26 15:30", "2026-11-26 17:50"],
      ["2026-11-26 20:10", "2026-11-26 21:30"],
    ]);
    // Nothing before "now" (Sunday 8 PM is before the window anyway).
    expect(free.every((f) => f.start >= base().window.start)).toBe(true);
  });

  it("honors skipped occurrences of recurring events", () => {
    const skipped = { ...VOLLEYBALL, recurrenceExceptions: ["2026-11-26"] };
    const free = busyFrom(base({ events: [SCHOOL, skipped] }));
    const thursday = free.filter((f) => f.date === "2026-11-26");
    expect(thursday).toHaveLength(1);
    expect(thursday[0].minutes).toBe(360);
  });

  it("ignores all-day events and unplaced flexible items", () => {
    const allDay: Commitment = { ...event("trip", "Field trip", "2026-11-24", "00:00", "00:00"), allDay: true, endsAt: at("2026-11-25", "00:00") };
    const unplaced: Commitment = { id: "u", title: "Someday", area: null, kind: "flexible", startsAt: null, endsAt: null };
    const free = busyFrom(base({ events: [SCHOOL, allDay, unplaced] }));
    expect(free.find((f) => f.date === "2026-11-24")?.minutes).toBe(360);
  });

  it("never offers time before now", () => {
    const free = busyFrom(base({ now: at("2026-11-23", "17:02") }));
    const monday = free.filter((f) => f.date === "2026-11-23");
    // now + 15 min lead, rounded up to 5 minutes.
    expect(local(monday[0].start)).toBe("2026-11-23 17:20");
  });

  it("removes protected time, including stretches that cross midnight", () => {
    const prefs: SchedulingPreferences = {
      ...PREFS,
      workingHours: { ...PREFS.workingHours, sa: [{ start: "00:00", end: "24:00" }] },
      protectedTimes: [
        { label: "Dinner", days: ["mo", "tu", "we", "th", "fr", "sa", "su"], start: "18:30", end: "19:15" },
        { label: "Sleep", days: ["fr", "sa"], start: "22:30", end: "07:30" },
      ],
    };
    const free = busyFrom(base({ preferences: prefs }));
    const monday = free.filter((f) => f.date === "2026-11-23").map((f) => [local(f.start), local(f.end)]);
    expect(monday).toEqual([
      ["2026-11-23 15:30", "2026-11-23 18:30"],
      ["2026-11-23 19:15", "2026-11-23 21:30"],
    ]);
    const saturday = free.filter((f) => f.date === "2026-11-28").map((f) => [local(f.start), local(f.end)]);
    expect(saturday[0][0]).toBe("2026-11-28 07:30"); // Friday's sleep ends 7:30 Saturday
    expect(saturday.at(-1)![1]).toBe("2026-11-28 22:30"); // Saturday's sleep starts 10:30 PM
  });
});

describe("planSchedule", () => {
  it("plans the chemistry example: study before the exam plus piano twice", () => {
    const exam = at("2026-12-04", "09:00");
    const input = base({
      window: { start: at("2026-11-23", "00:00"), end: at("2026-12-04", "09:00") },
      requests: [
        req({ id: "chem", title: "Study for chemistry exam", amount: { type: "total", minutes: 180 }, deadline: exam, priority: "high" }),
        req({ id: "piano", title: "Piano practice", amount: { type: "sessions", count: 2, minutesEach: 45 }, deadline: at("2026-11-30", "00:00") }),
      ],
    });
    const result = planSchedule(input);
    expect(result.fitsCompletely).toBe(true);
    expect(result.outcomes.map((o) => o.status)).toEqual(["scheduled", "scheduled"]);

    const chem = result.sessions.filter((s) => s.requestId === "chem");
    expect(chem.reduce((s, x) => s + x.durationMinutes, 0)).toBe(180);
    expect(chem.every((s) => s.durationMinutes <= PREFS.maxSessionMinutes)).toBe(true);
    expect(chem.every((s) => s.end <= exam)).toBe(true);
    expect(new Set(chem.map((s) => s.date)).size).toBe(chem.length); // spread across days

    const piano = result.sessions.filter((s) => s.requestId === "piano");
    expect(piano).toHaveLength(2);
    expect(piano[0].date).not.toBe(piano[1].date);
    expect(piano.map((s) => s.id)).toEqual(["piano:1", "piano:2"]);
    expect(piano[1].index).toBe(2);
    expect(piano[1].count).toBe(2);

    assertNoOverlaps(result, input);
    for (const s of result.sessions) {
      expect(s.reasons.length).toBeGreaterThan(0);
      expect(s.reasons.some((r) => r.code === "free_gap")).toBe(true);
    }
    expect(result.summary).toMatch(/^Everything fits/);
  });

  it("keeps sessions inside working hours and away from events by the buffer", () => {
    const input = base({ requests: [req({ id: "a", amount: { type: "total", minutes: 600 } })] });
    const result = planSchedule(input);
    const check = checkPlacements(input, result.sessions.map((s) => ({ id: s.id, start: s.start, end: s.end })));
    expect(check.ok).toBe(true);
    expect(check.results.flatMap((r) => r.warnings)).toEqual([]);
  });

  it("explains slots using the surrounding events", () => {
    const input = base({
      now: at("2026-11-26", "12:00"),
      window: { start: at("2026-11-26", "00:00"), end: at("2026-11-27", "00:00") },
      requests: [req({ id: "read", title: "Reading", amount: { type: "single", minutes: 60 } })],
    });
    const [s] = planSchedule(input).sessions;
    expect(local(s.start)).toBe("2026-11-26 15:30");
    expect(s.reasons[0].text).toBe("Fits between School and Volleyball at 6 PM.");
  });

  it("does not fill every free moment (daily cap and keep-free share)", () => {
    const input = base({ requests: [req({ id: "big", amount: { type: "total", minutes: 3000 } })] });
    const result = planSchedule(input);
    const perDay = new Map<string, number>();
    for (const s of result.sessions) perDay.set(s.date, (perDay.get(s.date) ?? 0) + s.durationMinutes);
    for (const [date, minutes] of perDay) {
      const free = findFreeTime(input).filter((f) => f.date === date).reduce((a, f) => a + f.minutes, 0);
      expect(minutes).toBeLessThanOrEqual(PREFS.dailyCapMinutes);
      expect(minutes).toBeLessThanOrEqual(free * 0.7);
    }
    expect(result.fitsCompletely).toBe(false);
    expect(result.outcomes[0].status).toBe("partial");
    expect(result.outcomes[0].issue?.code).toBe("daily_limits_reached");
    expect(result.outcomes[0].shortfallMinutes).toBe(3000 - result.outcomes[0].scheduledMinutes);
  });

  it("says honestly when there isn't enough time before a deadline", () => {
    const input = base({
      now: at("2026-11-23", "12:00"),
      requests: [
        req({ id: "essay", title: "Essay", amount: { type: "total", minutes: 600 }, deadline: at("2026-11-24", "23:59") }),
      ],
    });
    const result = planSchedule(input);
    const o = result.outcomes[0];
    expect(o.status).toBe("partial");
    expect(["no_time_before_deadline", "daily_limits_reached"]).toContain(o.issue?.code);
    expect(o.issue?.message).toMatch(/Only .* of Essay fits before Tue, Nov 24/);
    expect(result.summary).toMatch(/^Placed /);
    expect(result.sessions.every((s) => s.end <= at("2026-11-24", "23:59"))).toBe(true);
  });

  it("refuses deadlines that already passed", () => {
    const result = planSchedule(base({ requests: [req({ id: "late", amount: { type: "single", minutes: 30 }, deadline: at("2026-11-20", "10:00") })] }));
    expect(result.outcomes[0]).toMatchObject({ status: "unscheduled", issue: { code: "deadline_passed" } });
    expect(result.sessions).toEqual([]);
  });

  it("reports a block too long for any free stretch", () => {
    const result = planSchedule(base({ requests: [req({ id: "movie", amount: { type: "single", minutes: 500 } })] }));
    expect(result.outcomes[0].issue?.code).toBe("block_too_long");
  });

  it("splits long flexible work into shorter sessions when only short gaps exist", () => {
    // Fill each weekday so only ~60-minute gaps remain.
    const filler = event("club", "Club", "2026-11-02", "16:40", "21:30", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    const prefs = { ...PREFS, keepFreePercent: 0, workingHours: { ...PREFS.workingHours, sa: [], su: [] } };
    const input = base({ events: [SCHOOL, filler], preferences: prefs, requests: [req({ id: "proj", amount: { type: "total", minutes: 150 } })] });
    const result = planSchedule(input);
    expect(result.outcomes[0].status).toBe("scheduled");
    expect(result.sessions.every((s) => s.durationMinutes <= 60)).toBe(true);
    expect(result.sessions.some((s) => s.tradeoffs.some((t) => t.code === "shortened"))).toBe(true);
    assertNoOverlaps(result, input);
  });

  it("gives high priority work the scarce time first", () => {
    const prefs = { ...PREFS, keepFreePercent: 0, workingHours: { mo: [{ start: "15:30", end: "16:30" }], tu: [], we: [], th: [], fr: [], sa: [], su: [] } };
    const result = planSchedule(
      base({
        preferences: prefs,
        requests: [
          req({ id: "low", amount: { type: "single", minutes: 60 }, priority: "low" }),
          req({ id: "high", amount: { type: "single", minutes: 60 }, priority: "high" }),
        ],
      }),
    );
    expect(result.outcomes.map((o) => [o.requestId, o.status])).toEqual([
      ["low", "unscheduled"],
      ["high", "scheduled"],
    ]);
    expect(result.outcomes[0].issue?.code).toBe("not_enough_free_time");
  });

  it("respects buffers between its own sessions", () => {
    const input = base({ requests: [req({ id: "a", amount: { type: "sessions", count: 6, minutesEach: 30 } }), req({ id: "b", amount: { type: "sessions", count: 6, minutesEach: 30 } })] });
    const result = planSchedule(input);
    const spans = result.sessions.map((s) => [Date.parse(s.start), Date.parse(s.end)]).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("uses preferred days and avoids rejected times", () => {
    const first = planSchedule(base({ requests: [req({ id: "run", amount: { type: "single", minutes: 45 }, preferredDays: ["sa"] })] }));
    expect(first.sessions[0].date).toBe("2026-11-28");
    expect(first.sessions[0].reasons.some((r) => r.code === "preferred_day")).toBe(true);

    const rejected = { start: first.sessions[0].start, end: first.sessions[0].end };
    const second = planSchedule(base({ requests: [req({ id: "run", amount: { type: "single", minutes: 45 }, preferredDays: ["sa"], avoid: [rejected] })] }));
    expect(second.sessions[0].start).not.toBe(first.sessions[0].start);
    expect(Date.parse(second.sessions[0].start) >= Date.parse(rejected.end) || Date.parse(second.sessions[0].end) <= Date.parse(rejected.start)).toBe(true);
  });

  it("offers alternatives that are actually free", () => {
    const input = base({ requests: [req({ id: "x", amount: { type: "sessions", count: 3, minutesEach: 60 } })] });
    const result = planSchedule(input);
    const alts = result.sessions.flatMap((s) => s.alternatives.map((a, i) => ({ id: `${s.id}-alt${i}`, ...a })));
    expect(alts.length).toBeGreaterThan(0);
    for (const a of alts) {
      const others = result.sessions.filter((s) => !a.id.startsWith(`${s.id}-`));
      const check = checkPlacements(input, [a, ...others.map((s) => ({ id: s.id, start: s.start, end: s.end }))]);
      expect(check.results[0].conflicts).toEqual([]);
    }
  });

  it("treats extra busy blocks (pending proposals) as taken", () => {
    const input = base({
      now: at("2026-11-26", "12:00"),
      window: { start: at("2026-11-26", "00:00"), end: at("2026-11-27", "00:00") },
      busy: [{ start: at("2026-11-26", "15:30"), end: at("2026-11-26", "17:00"), title: "Pending plan" }],
      requests: [req({ id: "a", amount: { type: "single", minutes: 45 } })],
    });
    const [s] = planSchedule(input).sessions;
    expect(local(s.start)).toBe("2026-11-26 20:10");
  });

  it("is deterministic", () => {
    const input = base({
      requests: [
        req({ id: "a", amount: { type: "total", minutes: 240 }, deadline: at("2026-11-28", "12:00") }),
        req({ id: "b", amount: { type: "sessions", count: 3, minutesEach: 30 } }),
      ],
    });
    expect(planSchedule(input)).toEqual(planSchedule(structuredClone(input)));
  });

  it("validates requests one by one without throwing", () => {
    const result = planSchedule(
      base({
        requests: [
          req({ id: "ok", amount: { type: "single", minutes: 30 } }),
          req({ id: "ok", amount: { type: "single", minutes: 30 } }),
          { id: "nodur", title: "No duration" } as unknown as PlanRequest,
          req({ id: "neg", amount: { type: "single", minutes: -5 } }),
        ],
      }),
    );
    expect(result.outcomes.map((o) => o.status)).toEqual(["scheduled", "unscheduled", "unscheduled", "unscheduled"]);
    expect(result.outcomes.slice(1).every((o) => o.issue?.code === "invalid_request")).toBe(true);
  });

  it("rejects bad top-level input", () => {
    expect(() => planSchedule(base({ timeZone: "Mars/Base" }))).toThrow(SchedulingInputError);
    expect(() => planSchedule(base({ window: { start: at("2026-11-23", "00:00"), end: at("2027-03-01", "00:00") } }))).toThrow(/62 days/);
    expect(() => planSchedule(base({ window: { start: at("2026-11-23", "00:00"), end: at("2026-11-22", "00:00") } }))).toThrow(SchedulingInputError);
    expect(() => planSchedule(base({ preferences: { ...PREFS, minSessionMinutes: 120, maxSessionMinutes: 60 } }))).toThrow(SchedulingInputError);
  });

  it("returns no working hours honestly", () => {
    const prefs = { ...PREFS, workingHours: { mo: [], tu: [], we: [], th: [], fr: [], sa: [], su: [] } };
    const result = planSchedule(base({ preferences: prefs, requests: [req({ id: "a", amount: { type: "single", minutes: 30 } })] }));
    expect(result.outcomes[0].issue?.code).toBe("no_working_hours");
  });
});

describe("time zones and daylight saving", () => {
  it("keeps local working hours across the fall-back change (Nov 1, 2026)", () => {
    const input: PlanInput = {
      now: at("2026-10-30", "12:00"),
      timeZone: TZ,
      window: { start: at("2026-10-31", "00:00"), end: at("2026-11-03", "00:00") },
      events: [],
      preferences: { ...PREFS, keepFreePercent: 0, workingHours: { mo: [{ start: "16:00", end: "18:00" }], tu: [], we: [], th: [], fr: [], sa: [{ start: "16:00", end: "18:00" }], su: [{ start: "16:00", end: "18:00" }] } },
      requests: [],
    };
    const free = findFreeTime(input);
    expect(free.map((f) => [local(f.start), local(f.end), f.minutes])).toEqual([
      ["2026-10-31 16:00", "2026-10-31 18:00", 120],
      ["2026-11-01 16:00", "2026-11-01 18:00", 120],
      ["2026-11-02 16:00", "2026-11-02 18:00", 120],
    ]);
    // Same local time, different UTC offset after the change.
    expect(free[0].start).toBe("2026-10-31T23:00:00.000Z");
    expect(free[1].start).toBe("2026-11-02T00:00:00.000Z");
  });

  it("measures real elapsed time across the spring-forward night (Mar 8, 2026)", () => {
    const input: PlanInput = {
      now: at("2026-03-06", "12:00"),
      timeZone: TZ,
      window: { start: at("2026-03-07", "00:00"), end: at("2026-03-09", "00:00") },
      events: [],
      preferences: {
        ...PREFS,
        keepFreePercent: 0,
        workingHours: { mo: [], tu: [], we: [], th: [], fr: [], sa: [{ start: "00:00", end: "24:00" }], su: [{ start: "00:00", end: "24:00" }] },
        protectedTimes: [{ label: "Sleep", days: ["sa"], start: "23:00", end: "08:00" }],
      },
      requests: [],
    };
    const sunday = findFreeTime(input).filter((f) => f.date === "2026-03-08");
    // 8 AM to midnight Sunday is 16 real hours.
    expect(sunday.map((f) => [local(f.start), f.minutes])).toEqual([["2026-03-08 08:00", 960]]);
    const saturday = findFreeTime(input).filter((f) => f.date === "2026-03-07");
    expect(saturday.reduce((a, f) => a + f.minutes, 0)).toBe(23 * 60);
  });

  it("keeps recurring events at their local time across DST", () => {
    const practice = event("p", "Practice", "2026-10-26", "16:00", "17:00", "FREQ=DAILY");
    const input: PlanInput = {
      now: at("2026-10-30", "12:00"),
      timeZone: TZ,
      window: { start: at("2026-10-31", "00:00"), end: at("2026-11-03", "00:00") },
      events: [practice],
      preferences: { ...PREFS, bufferMinutes: 0, keepFreePercent: 0, workingHours: { mo: [{ start: "15:00", end: "18:00" }], tu: [], we: [], th: [], fr: [], sa: [{ start: "15:00", end: "18:00" }], su: [{ start: "15:00", end: "18:00" }] } },
      requests: [],
    };
    for (const f of findFreeTime(input)) {
      expect(["15:00", "17:00"]).toContain(local(f.start).slice(11));
      expect(f.minutes).toBe(60);
    }
  });

  it("plans in the user's zone, not the server's", () => {
    const tokyo = "Asia/Tokyo";
    const input: PlanInput = {
      now: at("2026-11-22", "20:00", tokyo),
      timeZone: tokyo,
      window: { start: at("2026-11-23", "00:00", tokyo), end: at("2026-11-24", "00:00", tokyo) },
      events: [],
      preferences: PREFS,
      requests: [req({ id: "a", amount: { type: "single", minutes: 30 } })],
    };
    const [s] = planSchedule(input).sessions;
    expect(s.date).toBe("2026-11-23");
    expect(s.startTime).toBe("15:30");
    expect(s.start).toBe("2026-11-23T06:30:00.000Z");
  });
});

describe("checkPlacements (re-check before approval)", () => {
  const input = base({ now: at("2026-11-24", "12:00") });

  it("catches an event added after the plan was made", () => {
    const placement = { id: "s1", start: at("2026-11-25", "16:00"), end: at("2026-11-25", "17:00"), title: "Study" };
    expect(checkPlacements(input, [placement]).ok).toBe(true);
    const later = base({ now: at("2026-11-24", "12:00"), events: [SCHOOL, VOLLEYBALL, event("extra", "Extra practice", "2026-11-25", "16:30", "18:00")] });
    const check = checkPlacements(later, [placement]);
    expect(check.ok).toBe(false);
    expect(check.results[0].conflicts).toEqual([
      { kind: "event", title: "Extra practice", start: at("2026-11-25", "16:30"), end: at("2026-11-25", "18:00") },
    ]);
  });

  it("catches placements that collide with each other", () => {
    const check = checkPlacements(input, [
      { id: "a", start: at("2026-11-25", "16:00"), end: at("2026-11-25", "17:00"), title: "A" },
      { id: "b", start: at("2026-11-25", "16:30"), end: at("2026-11-25", "17:30"), title: "B" },
    ]);
    expect(check.ok).toBe(false);
    expect(check.results.map((r) => r.conflicts.map((c) => c.kind))).toEqual([["placement"], ["placement"]]);
  });

  it("flags recurring event conflicts and soft warnings", () => {
    const prefs = { ...PREFS, protectedTimes: [{ label: "Dinner", days: ["we" as const], start: "19:00", end: "19:30" }] };
    const check = checkPlacements(base({ now: at("2026-11-25", "16:00"), preferences: prefs }), [
      { id: "school", start: at("2026-11-26", "14:00"), end: at("2026-11-26", "15:30") },
      { id: "past", start: at("2026-11-25", "15:30"), end: at("2026-11-25", "16:30") },
      { id: "dinner", start: at("2026-11-25", "19:00"), end: at("2026-11-25", "19:45") },
      { id: "late", start: at("2026-11-25", "21:00"), end: at("2026-11-25", "22:00") },
      { id: "tight", start: at("2026-11-26", "17:00"), end: at("2026-11-26", "17:55") },
      { id: "bad", start: "nope", end: at("2026-11-26", "17:55") },
    ]);
    const byId = Object.fromEntries(check.results.map((r) => [r.id, r]));
    expect(byId.school.conflicts[0]).toMatchObject({ kind: "event", title: "School" });
    expect(byId.past.warnings.map((w) => w.kind)).toContain("in_past");
    expect(byId.dinner.warnings.map((w) => w.kind)).toContain("protected_time");
    expect(byId.late.warnings.map((w) => w.kind)).toContain("outside_working_hours");
    expect(byId.tight.ok).toBe(true);
    expect(byId.tight.warnings.map((w) => w.kind)).toEqual(["buffer"]);
    expect(byId.bad.conflicts[0].kind).toBe("invalid");
    expect(check.ok).toBe(false);
  });
});
