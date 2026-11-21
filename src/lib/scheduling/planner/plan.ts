import { daysBetweenKeys, dateKeyInZone, timeKeyInZone } from "../zoned";
import { buildContext, GRID_MINUTES, type DayFrame, type ScheduleContext } from "./context";
import { dateLabel, durationLabel, plural, timeLabel, weekdayLabel } from "./format";
import {
  MINUTE,
  ceilTo,
  clipIntervals,
  mergeIntervals,
  overlaps,
  subtractIntervals,
  type Interval,
} from "./intervals";
import { evenSplit, planRequestSchema, requestedMinutes, sessionSizes, type ValidPlanRequest } from "./requests";
import type { IssueCode, PlanInput, PlanResult, ProposedSession, Reason, RequestOutcome } from "./types";

/**
 * The scheduling engine. Deterministic: the same input always gives the
 * same plan. It only proposes new blocks; it never moves or removes
 * existing events.
 *
 * Strategy (greedy, explainable):
 *  1. Work out each day's genuinely free time: working hours minus
 *     events (with buffers) and protected time, never before "now".
 *  2. Place requests in order: priority, then earliest deadline.
 *  3. For each session, score every free stretch that fits. Prefer
 *     lighter days, sessions spread across the available days, finishing
 *     well before deadlines and not running late into the evening.
 *  4. Each day keeps part of its free time open (keepFreePercent) and
 *     gets at most dailyCapMinutes of new work.
 *  5. If something cannot fit, say so honestly instead of forcing it.
 */

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Candidate = Interval & { day: DayFrame; score: number; sameDay: boolean };

type Placed = Interval & {
  requestId: string;
  title: string;
  day: DayFrame;
  shortened: boolean;
  candidate: Candidate;
  alternatives: Interval[];
};

type Prepared = {
  order: number;
  request: ValidPlanRequest;
  window: Interval;
  deadline: number | null;
  avoid: Interval[];
};

export function planSchedule(input: PlanInput): PlanResult {
  const ctx = buildContext(input);
  const prefs = ctx.preferences;
  const outcomes = new Map<number, RequestOutcome>();
  const prepared: Prepared[] = [];
  const seenIds = new Set<string>();

  (input.requests ?? []).forEach((raw, order) => {
    const parsed = planRequestSchema.safeParse(raw);
    const fallbackId = typeof raw?.id === "string" ? raw.id : `request-${order + 1}`;
    const fallbackTitle = typeof raw?.title === "string" ? raw.title : "Untitled";
    if (!parsed.success || seenIds.has(parsed.data.id)) {
      const message = parsed.success
        ? `Request id "${parsed.data.id}" is used twice.`
        : (parsed.error.issues[0]?.message ?? "Invalid request.");
      outcomes.set(order, failed(fallbackId, fallbackTitle, 0, "invalid_request", message));
      return;
    }
    const request = parsed.data;
    seenIds.add(request.id);
    const deadline = request.deadline ? Date.parse(request.deadline) : null;
    const earliest = request.earliestStart ? Math.max(ctx.earliest, Date.parse(request.earliestStart)) : ctx.earliest;
    const end = deadline === null ? ctx.window.end : Math.min(ctx.window.end, deadline);
    prepared.push({
      order,
      request,
      window: { start: ceilTo(earliest, GRID_MINUTES), end },
      deadline,
      avoid: request.avoid.map((a) => ({ start: Date.parse(a.start), end: Date.parse(a.end) })),
    });
  });

  prepared.sort(
    (a, b) =>
      PRIORITY_RANK[a.request.priority] - PRIORITY_RANK[b.request.priority] ||
      (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
      a.order - b.order,
  );

  const placed: Placed[] = [];
  const dayLoad = new Map<string, number>();

  for (const p of prepared) {
    const { request } = p;
    const wanted = requestedMinutes(request.amount);
    const queue = sessionSizes(request.amount, prefs).map((minutes) => ({ minutes, shortened: false }));
    const plannedCount = queue.length;
    const mine: Placed[] = [];
    let lastFailure: number | null = null;

    if (p.deadline !== null && p.deadline <= ctx.now) {
      outcomes.set(p.order, failed(request.id, request.title, wanted, "deadline_passed", `The deadline for ${request.title} has already passed.`));
      continue;
    }

    const eligible = ctx.days.filter((d) => d.usable.some((u) => u.start < p.window.end && u.end > p.window.start));

    while (queue.length) {
      const session = queue.shift()!;
      const length = session.minutes * MINUTE;
      const target = Math.max(plannedCount, mine.length + queue.length + 1);
      const candidates = findCandidates(ctx, p, eligible, length, placed, mine, dayLoad, target);
      const pick = candidates.find((c) => !c.sameDay) ?? candidates[0];
      if (!pick) {
        // Long flexible work can still fit as two shorter sessions.
        if (request.amount.type === "total" && session.minutes >= 2 * prefs.minSessionMinutes) {
          const [a, b] = evenSplit(session.minutes, 2);
          queue.unshift({ minutes: a, shortened: true }, { minutes: b, shortened: true });
          continue;
        }
        lastFailure = session.minutes;
        continue;
      }
      const alternatives = candidates
        .filter((c) => c !== pick && !overlaps(c, pick))
        .reduce<Interval[]>((acc, c) => {
          if (acc.length < 4 && !acc.some((a) => overlaps(a, c))) acc.push({ start: c.start, end: c.end });
          return acc;
        }, []);
      const entry: Placed = {
        start: pick.start,
        end: pick.end,
        requestId: request.id,
        title: request.title,
        day: pick.day,
        shortened: session.shortened,
        candidate: pick,
        alternatives,
      };
      mine.push(entry);
      placed.push(entry);
      dayLoad.set(pick.day.date, (dayLoad.get(pick.day.date) ?? 0) + session.minutes);
    }

    const scheduled = mine.reduce((sum, m) => sum + Math.round((m.end - m.start) / MINUTE), 0);
    const outcome: RequestOutcome = {
      requestId: request.id,
      title: request.title,
      status: scheduled >= wanted ? "scheduled" : scheduled > 0 ? "partial" : "unscheduled",
      requestedMinutes: wanted,
      scheduledMinutes: scheduled,
      shortfallMinutes: Math.max(0, wanted - scheduled),
      sessionIds: [],
    };
    if (outcome.status !== "scheduled") {
      outcome.issue = diagnose(ctx, p, eligible, lastFailure ?? 0, outcome, placed);
    }
    outcomes.set(p.order, outcome);
  }

  // Number sessions per request in time order and explain each one.
  const sessions: ProposedSession[] = [];
  const byRequest = new Map<string, Placed[]>();
  for (const s of placed) byRequest.set(s.requestId, [...(byRequest.get(s.requestId) ?? []), s]);
  for (const p of prepared) {
    const list = (byRequest.get(p.request.id) ?? []).sort((a, b) => a.start - b.start);
    const outcome = outcomes.get(p.order)!;
    list.forEach((s, i) => {
      const id = `${p.request.id}:${i + 1}`;
      outcome.sessionIds.push(id);
      sessions.push(toSession(ctx, p, s, id, i + 1, list.length, placed));
    });
  }
  sessions.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

  const ordered = [...outcomes.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
  const fitsCompletely = ordered.every((o) => o.status === "scheduled");
  return { sessions, outcomes: ordered, fitsCompletely, summary: summarize(ordered, sessions.length) };
}

// ---------- Candidates ----------

function dayLimitMinutes(ctx: ScheduleContext, day: DayFrame): number {
  const keep = Math.floor(day.freeMinutes * (1 - ctx.preferences.keepFreePercent / 100));
  return Math.min(ctx.preferences.dailyCapMinutes, keep);
}

function blockedByPlacements(ctx: ScheduleContext, placed: readonly Placed[]): Interval[] {
  return placed.map((s) => ({ start: s.start - ctx.buffer, end: s.end + ctx.buffer }));
}

function findCandidates(
  ctx: ScheduleContext,
  p: Prepared,
  eligible: readonly DayFrame[],
  length: number,
  placed: readonly Placed[],
  mine: readonly Placed[],
  dayLoad: ReadonlyMap<string, number>,
  plannedCount: number,
): Candidate[] {
  const blocked = [...blockedByPlacements(ctx, placed), ...p.avoid];
  const minutes = length / MINUTE;
  const out: Candidate[] = [];
  const preferred = p.request.preferredDays;

  eligible.forEach((day, position) => {
    const load = dayLoad.get(day.date) ?? 0;
    if (load + minutes > dayLimitMinutes(ctx, day)) return;
    const gaps = subtractIntervals(clipIntervals(day.free, p.window), blocked);
    const sameDay = mine.some((m) => m.day.date === day.date);
    const lastWorkEnd = day.working.length ? day.working[day.working.length - 1].end : day.free[0]?.end ?? 0;
    const firstWorkStart = day.working[0]?.start ?? 0;

    // Even spacing: session k of n aims for position (k + 0.5) / n through the days.
    const k = mine.length;
    const target = plannedCount > 1 ? ((k + 0.5) * eligible.length) / plannedCount - 0.5 : 0;
    const spread = plannedCount > 1 ? Math.abs(position - target) * 4 : position * 2;
    const loadRatio = (day.busyMinutes + load) / Math.max(day.workingMinutes, 1);

    for (const gap of gaps) {
      const start = ceilTo(gap.start, GRID_MINUTES);
      const end = start + length;
      if (end > gap.end) continue;
      let score = spread + loadRatio * 20;
      score += ((start - firstWorkStart) / HOUR) * 0.5;
      if (end > lastWorkEnd - HOUR) score += 5;
      if (p.deadline !== null && end > p.deadline - DAY) score += 15;
      if (preferred.length && !preferred.includes(day.weekday)) score += 25;
      if (sameDay) score += 40;
      out.push({ start, end, day, score, sameDay });
    }
  });

  return out.sort((a, b) => a.score - b.score || a.start - b.start);
}

// ---------- Honest failure messages ----------

function failed(requestId: string, title: string, wanted: number, code: IssueCode, message: string): RequestOutcome {
  return {
    requestId,
    title,
    status: "unscheduled",
    requestedMinutes: wanted,
    scheduledMinutes: 0,
    shortfallMinutes: wanted,
    sessionIds: [],
    issue: { code, message },
  };
}

function diagnose(
  ctx: ScheduleContext,
  p: Prepared,
  eligible: readonly DayFrame[],
  failedMinutes: number,
  outcome: RequestOutcome,
  placed: readonly Placed[],
): { code: IssueCode; message: string } {
  const { title } = p.request;
  const missing = durationLabel(outcome.shortfallMinutes);
  const by = p.deadline !== null ? ` before ${dateLabel(p.deadline, ctx.timeZone)} at ${timeLabel(p.deadline, ctx.timeZone)}` : " in this period";
  const lead = outcome.status === "partial" ? `Only ${durationLabel(outcome.scheduledMinutes)} of ${title} fits${by}` : `${title} doesn't fit${by}`;

  if (p.window.end <= p.window.start || !eligible.some((d) => d.working.length)) {
    if (p.deadline !== null) return { code: "no_time_before_deadline", message: `There's no working time left${by} for ${title}.` };
    return { code: "no_working_hours", message: `You have no working hours set in this period, so ${title} can't be placed.` };
  }
  const raw = eligible.flatMap((d) => clipIntervals(d.free, p.window));
  const longestOf = (gaps: Interval[]) =>
    gaps.reduce((max, g) => Math.max(max, (g.end - ceilTo(g.start, GRID_MINUTES)) / MINUTE), 0);
  // Even with an empty schedule, no stretch is long enough.
  if (p.request.amount.type === "single" && longestOf(raw) < failedMinutes) {
    return {
      code: "block_too_long",
      message: `${lead}: there's no free ${durationLabel(failedMinutes)} stretch${by}. Splitting it into shorter sessions would help.`,
    };
  }
  // Time still open after everything else was placed, ignoring daily limits.
  const open = subtractIntervals(raw, [...blockedByPlacements(ctx, placed), ...p.avoid]);
  if (longestOf(open) >= failedMinutes) {
    return {
      code: "daily_limits_reached",
      message: `${lead}. The rest would overload your days (up to ${durationLabel(ctx.preferences.dailyCapMinutes)} of new work a day, keeping ${ctx.preferences.keepFreePercent}% of free time open). ${missing} still needs a home.`,
    };
  }
  return {
    code: p.deadline !== null ? "no_time_before_deadline" : "not_enough_free_time",
    message: `${lead}. There isn't enough free time${by}; ${missing} is missing.`,
  };
}

function summarize(outcomes: readonly RequestOutcome[], sessionCount: number): string {
  if (!outcomes.length) return "Nothing to schedule.";
  const wanted = outcomes.reduce((s, o) => s + o.requestedMinutes, 0);
  const got = outcomes.reduce((s, o) => s + o.scheduledMinutes, 0);
  if (outcomes.every((o) => o.status === "scheduled")) {
    return `Everything fits: ${plural(sessionCount, "session")}, ${durationLabel(got)} in total.`;
  }
  const first = outcomes.find((o) => o.issue)?.issue?.message ?? "";
  if (got === 0) return `Nothing could be placed. ${first}`.trim();
  return `Placed ${durationLabel(got)} of ${durationLabel(wanted)}. ${first}`.trim();
}

// ---------- Explanations ----------

function toSession(
  ctx: ScheduleContext,
  p: Prepared,
  s: Placed,
  id: string,
  index: number,
  count: number,
  allPlaced: readonly Placed[],
): ProposedSession {
  const tz = ctx.timeZone;
  const r = p.request;
  const reasons: Reason[] = [];
  const tradeoffs: Reason[] = [];
  const dayStart = Math.min(...s.day.working.map((w) => w.start), s.start) - 6 * HOUR;
  const dayEnd = Math.max(...s.day.working.map((w) => w.end), s.end) + 6 * HOUR;
  const prev = [...ctx.busy].reverse().find((b) => b.end <= s.start && b.end > dayStart && dateKeyInZone(new Date(b.end - 1), tz) === s.day.date);
  const next = ctx.busy.find((b) => b.start >= s.end && b.start < dayEnd && dateKeyInZone(new Date(b.start), tz) === s.day.date);

  if (prev && next) {
    reasons.push({ code: "free_gap", text: `Fits between ${prev.title} and ${next.title} at ${timeLabel(next.start, tz)}.`, short: `After ${prev.title}` });
  } else if (prev) {
    reasons.push({ code: "free_gap", text: `You're free after ${prev.title} (ends ${timeLabel(prev.end, tz)}).`, short: `After ${prev.title}` });
  } else if (next) {
    reasons.push({ code: "free_gap", text: `Done before ${next.title} at ${timeLabel(next.start, tz)}.`, short: `Before ${next.title}` });
  } else {
    reasons.push({ code: "free_gap", text: `Nothing else is on your calendar ${weekdayLabel(s.day.date)} at this time.`, short: "Wide open" });
  }
  const snug = (gap: number) => gap <= ctx.buffer + 5 * MINUTE;
  if (ctx.buffer > 0 && ((prev && snug(s.start - prev.end)) || (next && snug(next.start - s.end)))) {
    reasons.push({ code: "buffer", text: `Leaves ${durationLabel(ctx.preferences.bufferMinutes)} of breathing room around your other plans.`, short: `${durationLabel(ctx.preferences.bufferMinutes)} buffer` });
  }

  // Only claim "lighter" when it's actually true compared with other days.
  const eligible = ctx.days.filter((d) => d.workingMinutes > 0 && d.usable.length);
  const ratio = (d: DayFrame) => d.busyMinutes / Math.max(d.workingMinutes, 1);
  const mine = ratio(s.day);
  const heavier = eligible.filter((d) => ratio(d) > mine).length;
  const lighter = eligible.filter((d) => ratio(d) < mine).length;
  if (heavier > 0 && lighter === 0 && eligible.filter((d) => ratio(d) === mine).length === 1) {
    reasons.push({ code: "light_day", text: `${weekdayLabel(s.day.date)} is your lightest day in this plan.`, short: "Lightest day" });
  } else if (heavier > 0 && lighter < heavier) {
    reasons.push({ code: "light_day", text: `${weekdayLabel(s.day.date)} is one of your lighter days.`, short: "Lighter day" });
  }

  if (p.deadline !== null) {
    const days = daysBetweenKeys(s.day.date, dateKeyInZone(new Date(p.deadline), tz));
    const hours = Math.floor((p.deadline - s.end) / HOUR);
    reasons.push({
      code: "before_deadline",
      text: days >= 1 ? `Done ${plural(days, "day")} before your deadline.` : `Done ${plural(Math.max(hours, 0), "hour")} before your deadline.`,
      short: days >= 1 ? `${days}d before due` : hours >= 1 ? `${hours}h before due` : "Just before due",
    });
    if (p.deadline - s.end < DAY) tradeoffs.push({ code: "near_deadline", text: "This is close to your deadline, so there's little room if plans change.", short: "Close to due" });
  }
  if (count > 1) reasons.push({ code: "spread", text: `Session ${index} of ${count}, spaced out from the others.` });
  if (r.priority === "high") reasons.push({ code: "priority", text: "Placed early because it's high priority.", short: "High priority" });
  if (r.preferredDays.length) {
    if (r.preferredDays.includes(s.day.weekday)) reasons.push({ code: "preferred_day", text: `${weekdayLabel(s.day.date)} is one of the days you asked for.`, short: "Your day" });
    else tradeoffs.push({ code: "not_preferred_day", text: `Not on a day you asked for; those were full.`, short: "Not your day" });
  }

  if (allPlaced.some((o) => o !== s && o.requestId === s.requestId && o.day.date === s.day.date)) {
    tradeoffs.push({ code: "same_day", text: "Shares the day with another session of this, because other days were full.", short: "Doubled up" });
  }
  if (s.shortened) tradeoffs.push({ code: "shortened", text: "Split into a shorter session because no longer free stretch was available.", short: "Shortened" });
  const lastWorkEnd = s.day.working.length ? s.day.working[s.day.working.length - 1].end : s.end;
  if (s.end > lastWorkEnd - HOUR) tradeoffs.push({ code: "late", text: "Runs into the last hour of your evening.", short: "Runs late" });
  if ((s.day.busyMinutes + sumOnDay(allPlaced, s.day.date)) / Math.max(s.day.workingMinutes, 1) > 0.7) {
    tradeoffs.push({ code: "busy_day", text: `${weekdayLabel(s.day.date)} is already fairly full.`, short: "Busy day" });
  }

  // Alternatives must still be free once every session is placed.
  const others = mergeIntervals(
    allPlaced.filter((o) => o !== s).map((o) => ({ start: o.start - ctx.buffer, end: o.end + ctx.buffer })),
  );
  const alternatives = s.alternatives.filter((a) => !others.some((o) => overlaps(o, a))).slice(0, 2);

  return {
    id,
    requestId: r.id,
    title: r.title,
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    date: s.day.date,
    startTime: timeKeyInZone(new Date(s.start), tz),
    endTime: timeKeyInZone(new Date(s.end), tz),
    durationMinutes: Math.round((s.end - s.start) / MINUTE),
    index,
    count,
    reasons,
    tradeoffs,
    nearby: ctx.busy
      .filter((b) => b.end > s.start - 3 * HOUR && b.start < s.end + 3 * HOUR && dateKeyInZone(new Date(b.start), tz) === s.day.date)
      .slice(0, 6)
      .map((b) => ({ title: b.title, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })),
    deadline: p.deadline !== null ? new Date(p.deadline).toISOString() : null,
    alternatives: alternatives.map((a) => ({ start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString() })),
    lifeAreaId: r.lifeAreaId,
    taskId: r.taskId,
    habitId: r.habitId,
    goalId: r.goalId,
  };
}

function sumOnDay(placed: readonly Placed[], date: string): number {
  return placed.filter((p) => p.day.date === date).reduce((s, p) => s + (p.end - p.start) / MINUTE, 0);
}
