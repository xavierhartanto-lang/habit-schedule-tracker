import { normalizeText } from "@/lib/ai/extraction";
import type { Clarify, ClarifyField } from "@/features/assistant/plan-types";
import type { Commitment, ContextAttributes, Goal, Habit, HabitCadence, LifeAreaRecord, Task, Weekday } from "@/lib/domain/types";
import { WEEKDAYS } from "@/lib/domain/types";
import { expandEvent } from "@/lib/scheduling/recurrence";
import { addDaysToKey, dateKeyInZone, startOfDayInZone, timeKeyInZone } from "@/lib/scheduling/zoned";
import { addMinutesToTime, firstMatchingDay, hasDateRef, minutesBetweenTimes, resolveDateRef, shortDate, weekdayName, weekdayOf } from "./dates";
import type { Intent, PlanWindow } from "./intents";
import { isGenericToken, nameScore, nameTokens, resolveEntity } from "./resolve";

const GENERIC_WORDS = { has: isGenericToken };

/**
 * Decides, for each intent, whether Whitespace has everything it needs or
 * which single question to ask next. Never guesses a missing day, time,
 * duration or amount: those become questions. Pure, unit tested.
 */

/** Short refs the planner sees for existing records (t1, e2, b3, h1, g4). */
export type RefTable = {
  tasks: Map<string, Task>;
  events: Map<string, Commitment>;
  /** Sessions the assistant scheduled earlier (flexible, plan_item_id set). */
  blocks: Map<string, Commitment>;
  habits: Map<string, Habit>;
  goals: Map<string, Goal>;
};

/** An activity the user already has, with its usual time and length (for smart defaults). */
export type KnownActivity = { title: string; startTime: string | null; durationMinutes: number | null; source: "event" | "fact" };

export type World = {
  todayKey: string;
  timeZone: string;
  weekStartsOn: 0 | 1;
  areas: LifeAreaRecord[];
  refs: RefTable;
  /** Activities with a usual time or length: saved events and onboarding facts. */
  known?: KnownActivity[];
  /** Refs this conversation is about right now ("it", "that"): named recently or touched by an action. */
  focus?: string[];
  /** Local time now, "HH:MM", for "in two hours". */
  nowTime?: string;
};

/** What changes on an existing event. Fields left undefined stay as they are. */
export type EventChange = {
  title?: string;
  /** New local date of the (first) occurrence. */
  date?: string;
  startTime?: string;
  endTime?: string;
  /** New repeat rule; null = make it one time. */
  rrule?: string | null;
  recurrenceText?: string | null;
  location?: string | null;
};

export type ActionSpec =
  | {
      kind: "event";
      title: string;
      lifeAreaId: string | null;
      /** First occurrence, local. */
      date: string;
      startTime: string;
      endTime: string;
      /** RRULE or null for one time. */
      rrule: string | null;
      recurrenceText: string | null;
      location: string | null;
      notes: string | null;
      /** What Whitespace filled in from what it already knows ("Same length as your usual Basketball Practice."). */
      assumed?: string | null;
    }
  | {
      /** Change a saved event. scope "one" = only `occurrenceDate` of a repeating event. */
      kind: "event_update";
      event: Commitment;
      scope: "all" | "one";
      occurrenceDate: string | null;
      change: EventChange;
    }
  | {
      kind: "task_create";
      title: string;
      lifeAreaId: string | null;
      dueDate: string | null;
      dueTime: string | null;
      estimatedMinutes: number | null;
      priority: "high" | "medium" | "low";
      description: string | null;
    }
  | {
      kind: "task_update";
      task: Task;
      patch: {
        title?: string;
        priority?: "high" | "medium" | "low";
        dueDate?: string;
        dueTime?: string | null;
        estimatedMinutes?: number;
      };
    }
  | { kind: "task_complete"; task: Task }
  | { kind: "task_remove"; task: Task }
  | { kind: "habit_create"; title: string; lifeAreaId: string | null; cadence: HabitCadence }
  | { kind: "habit_update"; habit: Habit; cadence: HabitCadence }
  | { kind: "goal_create"; title: string; lifeAreaId: string | null; targetDate: string | null; description: string | null }
  | { kind: "goal_update"; goal: Goal; progress: number | null; targetDate: string | null }
  | {
      kind: "set_area";
      table: "commitments" | "tasks" | "habits" | "goals";
      id: string;
      title: string;
      lifeAreaId: string | null;
      areaName: string;
    }
  | {
      kind: "prefs";
      dayStart: string | null;
      dayEnd: string | null;
      maxSessionMinutes: number | null;
      bufferMinutes: number | null;
      protectedTime: { label: string; days: Weekday[]; start: string; end: string } | null;
    }
  | {
      kind: "fact";
      category: "activity" | "interest" | "routine" | "working_time" | "preference";
      title: string;
      details: string | null;
      lifeAreaId: string | null;
      attributes: ContextAttributes;
    }
  | {
      kind: "plan_time";
      title: string;
      amount:
        | { type: "single"; minutes: number }
        | { type: "total"; minutes: number }
        | { type: "sessions"; count: number; minutesEach: number };
      priority: "high" | "medium" | "low";
      /** Local date + optional time the work must be done by. */
      deadlineDate: string | null;
      deadlineTime: string | null;
      window: PlanWindow;
      preferredDays: Weekday[];
      taskId: string | null;
      lifeAreaId: string | null;
    }
  | { kind: "cant_make"; date: string | null; blocks: Commitment[]; event: Commitment | null; title: string }
  /** Every matching event goes (a repeating event goes as a whole series). Empty when nothing matched. */
  | { kind: "remove_event"; events: Commitment[]; title: string }
  | { kind: "finished_early"; task: Task | null; title: string }
  | { kind: "not_enough_time"; window: PlanWindow };

export type Assessment =
  | { status: "ready"; spec: ActionSpec; intent: Intent }
  | { status: "needs"; clarify: Clarify; intent: Intent }
  /** Nothing to do. `note` tells the reply model what to say ("No training task exists."). */
  | { status: "skip"; reason: string; intent: Intent; note?: string };

const DURATION_CHOICES = ["1 hour", "90 minutes", "2 hours"];

function lifeAreaId(world: World, name: string | null): string | null {
  if (!name) return null;
  const n = normalizeText(name);
  const exact = world.areas.find((a) => normalizeText(a.name) === n);
  if (exact) return exact.id;
  const partial = world.areas.find((a) => normalizeText(a.name).includes(n) || n.includes(normalizeText(a.name)));
  return partial?.id ?? null;
}

function needs(intent: Intent, field: ClarifyField, about: string, question: string, choices: string[] = []): Assessment {
  return { status: "needs", intent, clarify: { field, about, question, choices } };
}

function label(intent: Intent, fallback: string): string {
  return intent.title ?? fallback;
}

function lower(title: string): string {
  // "Volleyball" -> "volleyball" for mid-sentence use. Multi-word names in
  // title case ("Math Tutoring") are names, and acronyms ("SAT prep") stay as written.
  if (/\s[A-Z]/.test(title)) return title;
  return /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title;
}


const PRONOUN = /^(?:it|that|this|them|those|these|the one|that one|this one|the other one|the other|same|same one)$/i;

type Found<T> = { ok: true; ref: string; item: T } | { ok: false; result: Assessment };

/** "Basketball Game (Fri Nov 20)" when several records share a name. */
function optionLabel(item: { title: string; startsAt?: string | null }, all: { title: string }[], timeZone: string): string {
  const twins = all.filter((o) => normalizeText(o.title) === normalizeText(item.title)).length > 1;
  if (twins && item.startsAt) return `${item.title} (${shortDate(dateKeyInZone(new Date(item.startsAt), timeZone))})`;
  return item.title;
}

/**
 * Finds the existing record an intent is about, deterministically.
 * - Named ("mark training done"): the name must match. No match = nothing
 *   happens and the reply says so; never a similar-sounding stand-in.
 * - "it" / "that": only records this conversation is about right now.
 * - Several fit: one short question with the options.
 */
function findTarget<T extends { id: string; title: string; startsAt?: string | null }>(
  intent: Intent,
  world: World,
  map: Map<string, T>,
  noun: string,
  options: { words?: string | null; onDate?: string | null } = {},
): Found<T> {
  const words = options.words !== undefined ? options.words : intent.targetName ?? intent.title;
  const pronoun = !words || PRONOUN.test(words.trim().replace(/[.!?]+$/, ""));
  const all = [...map.values()];
  const ask = (refs: string[], about: string): Found<T> => {
    const labels = refs.map((r) => optionLabel(map.get(r)!, all, world.timeZone));
    return { ok: false, result: needs(intent, "target", about, `Which ${noun}: ${listLabels(labels)}?`, labels.slice(0, 4)) };
  };
  // The user just picked from our own options: trust the pick.
  if (intent.targetConfirmed && intent.targetRef && map.has(intent.targetRef)) {
    return { ok: true, ref: intent.targetRef, item: map.get(intent.targetRef)! };
  }

  if (!pronoun) {
    const r = resolveEntity(map, intent.targetRef, words);
    if (r.kind === "one") return { ok: true, ref: r.ref, item: r.item };
    if (r.kind === "ask") {
      let refs = r.options.map((o) => o.ref);
      // Same name on several days: the day the user named picks one.
      if (options.onDate) {
        const onDay = refs.filter((ref) => occursOn(map.get(ref)!, options.onDate!, world.timeZone));
        if (onDay.length === 1) return { ok: true, ref: onDay[0], item: map.get(onDay[0])! };
        if (onDay.length > 1) refs = onDay;
      }
      return ask(refs, words!);
    }
    return {
      ok: false,
      result: {
        status: "skip",
        intent,
        reason: "No matching record.",
        note: `Nothing called "${words}" was found among the user's ${noun}s, so nothing was changed. Say so plainly; do not pick something similar.`,
      },
    };
  }

  // No name given, but the model's pick is named in the user's own words ("find time for my chem hw").
  if (intent.targetRef && map.has(intent.targetRef) && mentions(intent.evidence, map.get(intent.targetRef)!.title)) {
    return { ok: true, ref: intent.targetRef, item: map.get(intent.targetRef)! };
  }

  // "it" / "that": what this conversation is about.
  let focus = (world.focus ?? []).filter((r) => map.has(r));
  if (options.onDate && focus.length > 1) {
    const onDay = focus.filter((ref) => occursOn(map.get(ref)!, options.onDate!, world.timeZone));
    if (onDay.length) focus = onDay;
  }
  if (focus.length === 1) return { ok: true, ref: focus[0], item: map.get(focus[0])! };
  if (focus.length > 1) return ask(focus.slice(0, 4), noun[0].toUpperCase() + noun.slice(1));
  const guess = intent.targetRef && map.has(intent.targetRef) ? [intent.targetRef] : [];
  const similar = guess.length
    ? [...map.entries()].filter(([r, v]) => r !== guess[0] && nameScore(map.get(guess[0])!.title, v.title) > 0).map(([r]) => r)
    : [];
  if (guess.length && !similar.length && all.length === 1) return { ok: true, ref: guess[0], item: map.get(guess[0])! };
  const refs = [...guess, ...similar].slice(0, 4);
  if (!refs.length) return { ok: false, result: needs(intent, "target", noun, `Which ${noun} do you mean?`) };
  return ask(refs, noun[0].toUpperCase() + noun.slice(1));
}

/** Every specific word of the name appears in the text ("my chem hw" mentions "Chemistry Homework"). */
function mentions(text: string, title: string): boolean {
  const have = new Set(nameTokens(text));
  const tokens = nameTokens(title);
  const specific = tokens.filter((t) => !GENERIC_WORDS.has(t));
  const need = specific.length ? specific : tokens;
  return need.length > 0 && need.every((t) => have.has(t));
}

function listLabels(labels: string[]): string {
  const l = labels.slice(0, 4);
  if (l.length <= 1) return l[0] ?? "";
  return `${l.slice(0, -1).join(", ")} or ${l[l.length - 1]}`;
}

/** Does the event (or any repeat of it) happen on this local day? */
export function occursOn(item: { startsAt?: string | null }, dateKey: string, timeZone: string): boolean {
  const event = item as Commitment;
  if (!event.startsAt) return false;
  if (!event.recurrenceRule) return dateKeyInZone(new Date(event.startsAt), event.timezone ?? timeZone) === dateKey;
  const from = startOfDayInZone(dateKey, event.timezone ?? timeZone);
  const to = startOfDayInZone(addDaysToKey(dateKey, 1), event.timezone ?? timeZone);
  return expandEvent(event, from, to, timeZone).length > 0;
}

/** Next day (today included) the event happens, as a local date. */
function nextOccurrence(event: Commitment, todayKey: string, timeZone: string): string | null {
  if (!event.startsAt) return null;
  const tz = event.timezone ?? timeZone;
  if (!event.recurrenceRule) return dateKeyInZone(new Date(event.startsAt), tz);
  const from = startOfDayInZone(todayKey, tz);
  const occ = expandEvent(event, from, new Date(from.getTime() + 15 * 86_400_000), timeZone)[0];
  return occ ? dateKeyInZone(occ.start, tz) : null;
}

/** Finds a record by ref, or by title when the model gave no ref. */
function findByRef<T extends { title: string }>(map: Map<string, T>, ref: string | null, title: string | null): T | null {
  if (ref && map.has(ref)) return map.get(ref)!;
  if (!title) return null;
  const n = normalizeText(title);
  const matches = [...map.values()].filter((v) => {
    const t = normalizeText(v.title);
    return t === n || t.includes(n) || n.includes(t);
  });
  return matches.length === 1 ? matches[0] : null;
}

function candidates<T extends { title: string }>(map: Map<string, T>, title: string | null): string[] {
  const all = [...map.values()];
  if (!title) return all.slice(0, 3).map((v) => v.title);
  const words = normalizeText(title).split(" ").filter((w) => w.length > 2);
  return all
    .filter((v) => words.some((w) => normalizeText(v.title).includes(w)))
    .slice(0, 3)
    .map((v) => v.title);
}

function eventTimes(intent: Intent): { start: string; end: string } | { missing: "time" | "duration" } {
  if (!intent.startTime) return { missing: "time" };
  if (intent.endTime) {
    if (minutesBetweenTimes(intent.startTime, intent.endTime) <= 0) return { missing: "duration" };
    return { start: intent.startTime, end: intent.endTime };
  }
  if (intent.durationMinutes) {
    const end = addMinutesToTime(intent.startTime, intent.durationMinutes);
    if (!end) return { missing: "duration" };
    return { start: intent.startTime, end };
  }
  return { missing: "duration" };
}

const RRULE_DAY: Record<Weekday, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };

function recurrenceFor(intent: Intent, firstDate: string): { rrule: string | null; text: string | null } {
  switch (intent.recurrence) {
    case "daily":
      return { rrule: "FREQ=DAILY", text: "Every day" };
    case "weekdays":
      return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", text: "Every weekday" };
    case "weekly": {
      const days = intent.days.length ? intent.days : [weekdayOf(firstDate)];
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${days.map((d) => RRULE_DAY[d]).join(",")}`,
        text: `Every ${days.map((d) => weekdayName(d)).join(" and ")}`,
      };
    }
    default:
      return { rrule: null, text: null };
  }
}

/** "In two hours" -> a local date and start time, rounded up to 5 minutes. */
function fromOffset(intent: Intent, world: World): Intent {
  if (!intent.startInMinutes || !world.nowTime) return intent;
  const [h, m] = world.nowTime.split(":").map(Number);
  const total = Math.ceil((h * 60 + m + intent.startInMinutes) / 5) * 5;
  const days = Math.floor(total / 1440);
  const minutes = total % 1440;
  const startTime = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { ...intent, startTime, date: { isoDate: addDaysToKey(world.todayKey, days), weekday: null, week: null, dayOffset: null }, recurrence: intent.recurrence ?? "once" };
}

function assessEvent(raw: Intent, world: World): Assessment {
  const intent = fromOffset(raw, world);
  const title = label(intent, "this");
  if (!intent.title) return needs(intent, "other", "Event", "What should I call it?");

  // Which day(s). Recurring events can be anchored by their days alone.
  const recurringDays = intent.recurrence === "weekly" ? intent.days : [];
  let date = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
  if (!date && intent.recurrence === "weekdays") date = firstMatchingDay(world.todayKey, ["mo", "tu", "we", "th", "fr"]);
  if (!date && intent.recurrence === "daily") date = world.todayKey;
  if (!date && recurringDays.length) date = firstMatchingDay(world.todayKey, recurringDays);
  if (!date && !hasDateRef(intent.date) && intent.days.length) date = firstMatchingDay(world.todayKey, intent.days);
  if (!date) return needs(intent, "date", title, `What day is ${lower(title)}?`);

  // One time or repeating. Only ask when it reads like a routine (weekday given, no calendar date).
  if (intent.recurrence === null) {
    const looksRoutine = !!intent.date?.weekday && !intent.date.isoDate && intent.date.week === null;
    if (looksRoutine || intent.days.length) {
      const day = weekdayName(intent.days[0] ?? weekdayOf(date));
      return needs(intent, "recurrence", title, `Is that every ${day} or just this ${day}?`, [
        `Every ${day}`,
        "Just this week",
      ]);
    }
  }

  // Fill gaps from what the user already has: the same activity's usual time and length.
  let assumed: string | null = null;
  let filled = intent;
  let times = eventTimes(filled);
  if ("missing" in times) {
    const known = usual(world, intent.title);
    if (known) {
      const usedTime = times.missing === "time" && known.startTime && known.durationMinutes;
      const usedLength = times.missing === "duration" && known.durationMinutes;
      if (usedTime) {
        filled = { ...filled, startTime: known.startTime, durationMinutes: known.durationMinutes, endTime: null };
        assumed = `Your usual time for ${known.title}.`;
      } else if (usedLength) {
        filled = { ...filled, durationMinutes: known.durationMinutes, endTime: null };
        assumed = `Same length as your usual ${known.title}.`;
      }
      times = eventTimes(filled);
    }
  }
  if ("missing" in times) {
    if (times.missing === "time") return needs(intent, "time", title, `What time does ${lower(title)} start?`);
    return needs(intent, "duration", title, `How long does ${lower(title)} usually last?`, DURATION_CHOICES);
  }

  const rec = recurrenceFor(intent, date);
  return {
    status: "ready",
    intent,
    spec: {
      kind: "event",
      title: intent.title,
      lifeAreaId: lifeAreaId(world, intent.area),
      date,
      startTime: times.start,
      endTime: times.end,
      rrule: rec.rrule,
      recurrenceText: rec.text,
      location: intent.location,
      notes: intent.details,
      assumed,
    },
  };
}


/** Usual time and length of an activity the user already has, matched by name. */
function usual(world: World, title: string): KnownActivity | null {
  const list = (world.known ?? []).filter((k) => nameScore(title, k.title) >= 0.99);
  return list.find((k) => k.source === "event") ?? list[0] ?? null;
}

/**
 * Changes to a saved event: rename, move, new time or length, repeat rule.
 * Everything not mentioned stays as it is. A repeating event asks "just
 * this one or every week?" only when the answer changes what happens.
 */
function assessEventUpdate(original: Intent, world: World): Assessment {
  // "Just this week" next to another change means only that day, not "stop repeating".
  const otherChange = !!(original.startTime || original.endTime || original.durationMinutes || original.date || original.location || (original.title && original.targetName));
  const intent: Intent =
    original.recurrence === "once" && otherChange && !original.scope ? { ...original, recurrence: null, scope: "one" } : original;
  const calendar = new Map<string, Commitment>([...world.refs.events, ...world.refs.blocks]);
  const found = findTarget(intent, world, calendar, "event", { words: intent.targetName });
  if (!found.ok) return found.result;
  const event = found.item;
  const tz = event.timezone ?? world.timeZone;
  if (!event.startsAt || !event.endsAt) return { status: "skip", intent, reason: "No time.", note: `${event.title} has no time yet, so it can't be moved here.` };

  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const oldDate = dateKeyInZone(start, tz);
  const oldStart = timeKeyInZone(start, tz);
  const oldEnd = timeKeyInZone(end, tz);
  const length = Math.round((end.getTime() - start.getTime()) / 60_000);
  const recurring = !!event.recurrenceRule;

  const change: EventChange = {};
  const newTitle = intent.title && normalizeText(intent.title) !== normalizeText(event.title) && nameScore(intent.targetName, intent.title) < 0.99 ? intent.title : null;
  if (newTitle) change.title = newTitle;
  if (intent.location) change.location = intent.location;

  // Times: a new start keeps the length unless a new end or length is given.
  if (intent.startTime || intent.endTime || intent.durationMinutes) {
    const s = intent.startTime ?? oldStart;
    const e = intent.endTime ?? (intent.durationMinutes ? addMinutesToTime(s, intent.durationMinutes) : addMinutesToTime(s, length));
    if (!e || minutesBetweenTimes(s, e) <= 0) return needs(intent, "duration", event.title, `When does ${lower(event.title)} end?`);
    if (s !== oldStart) change.startTime = s;
    if (e !== oldEnd) change.endTime = e;
    if (change.startTime && !change.endTime) change.endTime = e;
    if (change.endTime && !change.startTime) change.startTime = s;
  }

  const day = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
  // Repeat rule changes: "make that every Friday", "it's only this week".
  if (intent.recurrence === "weekly" || intent.recurrence === "weekdays" || intent.recurrence === "daily") {
    const anchor = day ?? oldDate;
    const rec = recurrenceFor(intent, anchor);
    if (rec.rrule && rec.rrule !== event.recurrenceRule) {
      change.rrule = rec.rrule;
      change.recurrenceText = rec.text;
      // Weekly on other days: the first one is the next matching day.
      const first = recurringFirstDate(intent, anchor, world);
      if (first && first !== oldDate) change.date = first;
    }
  } else if (intent.recurrence === "once" && recurring) {
    change.rrule = null;
    change.recurrenceText = null;
    const next = day ?? nextOccurrence(event, world.todayKey, world.timeZone);
    if (next) change.date = next;
  }

  let scope: "all" | "one" = recurring ? (intent.scope ?? "all") : "all";
  let occurrenceDate: string | null = null;

  if (day && change.date === undefined && change.rrule === undefined) {
    if (recurring) {
      // "Move Friday's practice to 6": the day names the occurrence. "Move practice to Friday": a new day.
      const dayIsOccurrence = occursOn(event, day, world.timeZone) && (change.startTime || change.title);
      if (dayIsOccurrence) {
        occurrenceDate = day;
        if (!intent.scope) scope = "one";
      } else {
        if (!intent.scope) {
          return needs(intent, "scope", event.title, `Just this week, or every week?`, ["Just this week", "Every week"]);
        }
        if (scope === "one") {
          occurrenceDate = nextOccurrence(event, world.todayKey, world.timeZone);
          change.date = day;
        } else {
          // Every week on the new day: shift the series by the weekday difference.
          change.date = day;
          change.rrule = event.recurrenceRule!.replace(/BYDAY=[A-Z,]+/, `BYDAY=${RRULE_DAY[weekdayOf(day)]}`);
          change.recurrenceText = `Every ${weekdayName(weekdayOf(day))}`;
        }
      }
    } else if (day !== oldDate) {
      change.date = day;
    }
  }

  if (recurring && scope === "one" && !occurrenceDate) {
    occurrenceDate = intent.scope === "one" && day && occursOn(event, day, world.timeZone) ? day : nextOccurrence(event, world.todayKey, world.timeZone);
  }

  if (recurring && (change.startTime || change.title) && !intent.scope && scope === "all" && !change.rrule && change.rrule !== null && !change.date) {
    return needs(intent, "scope", event.title, `Just this week, or every week?`, ["Just this week", "Every week"]);
  }

  if (!Object.keys(change).length) {
    return needs(intent, "other", event.title, `What should change about ${lower(event.title)}?`);
  }
  return { status: "ready", intent, spec: { kind: "event_update", event, scope, occurrenceDate, change } };
}

function recurringFirstDate(intent: Intent, anchor: string, world: World): string | null {
  if (intent.recurrence === "weekdays") return firstMatchingDay(anchor < world.todayKey ? world.todayKey : anchor, ["mo", "tu", "we", "th", "fr"]);
  if (intent.recurrence === "weekly" && intent.days.length) return firstMatchingDay(anchor < world.todayKey ? world.todayKey : anchor, intent.days);
  return null;
}

function cadenceOf(intent: Intent): HabitCadence | null {
  if (intent.cadence === "daily") return { type: "daily" };
  if (intent.cadence === "specific_days" && intent.days.length) return { type: "specific_days", days: intent.days };
  if (intent.cadence === "weekly" && intent.timesPerWeek) return { type: "weekly", timesPerWeek: intent.timesPerWeek };
  if (!intent.cadence && intent.timesPerWeek) return { type: "weekly", timesPerWeek: intent.timesPerWeek };
  if (!intent.cadence && intent.days.length) return { type: "specific_days", days: intent.days };
  return null;
}

export type PlanAmount = Extract<ActionSpec, { kind: "plan_time" }>["amount"];

function planAmount(intent: Intent): PlanAmount | null {
  if (intent.amountKind === "sessions" || (intent.sessionCount && !intent.amountKind)) {
    if (!intent.sessionCount) return null;
    const each = intent.sessionMinutes ?? (intent.amountMinutes ? Math.round(intent.amountMinutes / intent.sessionCount) : null);
    if (!each) return null;
    return { type: "sessions", count: intent.sessionCount, minutesEach: each };
  }
  if (!intent.amountMinutes) return null;
  return intent.amountKind === "single"
    ? { type: "single", minutes: intent.amountMinutes }
    : { type: "total", minutes: intent.amountMinutes };
}

/** An open task with exactly this name, so "time for Chemistry Homework" books time for that task. */
function taskNamed<T extends { title: string }>(map: Map<string, T>, title: string | null): T | null {
  if (!title) return null;
  const n = normalizeText(title);
  const matches = [...map.values()].filter((t) => normalizeText(t.title) === n);
  return matches.length === 1 ? matches[0] : null;
}

function assessPlanTime(intent: Intent, world: World): Assessment {
  // "Schedule that for tomorrow": the task this conversation is about, verified by name when one is given.
  let task: Task | null = null;
  if (intent.targetRef || intent.targetName) {
    // The title here is the name for new sessions, not a reference: only target_name names the task.
    const found = findTarget(intent, world, world.refs.tasks, "task", { words: intent.targetName });
    if (found.ok) task = found.item;
    else if (found.result.status === "needs") return found.result;
  }
  task ??= taskNamed(world.refs.tasks, intent.title);
  // Sessions for a task carry the task's own name, so the two stay clearly linked.
  const title = task?.title ?? intent.title ?? null;
  if (!title) return needs(intent, "other", "Planning", "What would you like me to find time for?");

  let amount = planAmount(intent);
  if (!amount && task?.estimatedMinutes) amount = { type: "total", minutes: task.estimatedMinutes };
  if (!amount) {
    if (intent.sessionCount && !intent.sessionMinutes) {
      return needs(intent, "duration", title, `How long should each ${lower(title)} session be?`, ["30 minutes", "45 minutes", "1 hour"]);
    }
    return needs(intent, "amount", title, `About how much time do you need for ${lower(title)}?`, ["1 hour", "2 hours", "3 hours"]);
  }

  const deadlineDate = resolveDateRef(intent.deadline, world.todayKey, world.weekStartsOn);
  let deadlineTime = intent.deadlineTime;
  if (deadlineDate && deadlineDate < world.todayKey) {
    return needs(intent, "deadline", title, `That date has passed. When is ${lower(title)} due?`);
  }
  if (!deadlineDate) deadlineTime = null;

  const window: PlanWindow =
    intent.window ?? (deadlineDate || task?.dueAt ? "until_deadline" : "this_week");

  return {
    status: "ready",
    intent,
    spec: {
      kind: "plan_time",
      title,
      amount,
      priority: intent.priority ?? task?.priority ?? "medium",
      deadlineDate,
      deadlineTime,
      window,
      preferredDays: intent.days,
      taskId: task?.id ?? null,
      lifeAreaId: lifeAreaId(world, intent.area) ?? task?.lifeAreaId ?? null,
    },
  };
}

export function assessIntent(intent: Intent, world: World): Assessment {
  const { refs } = world;
  switch (intent.type) {
    case "create_event":
      return assessEvent(intent, world);

    case "create_task": {
      if (!intent.title) return needs(intent, "other", "Task", "What's the task?");
      const dueDate = resolveDateRef(intent.deadline ?? intent.date, world.todayKey, world.weekStartsOn);
      return {
        status: "ready",
        intent,
        spec: {
          kind: "task_create",
          title: intent.title,
          lifeAreaId: lifeAreaId(world, intent.area),
          dueDate,
          dueTime: dueDate ? intent.deadlineTime : null,
          estimatedMinutes: intent.amountMinutes ?? intent.durationMinutes,
          priority: intent.priority ?? "medium",
          description: intent.details,
        },
      };
    }

    case "update_task":
    case "complete_task":
    case "remove_task": {
      // Verified against the user's words: never a similar-sounding stand-in (see findTarget).
      const found = findTarget(intent, world, refs.tasks, "task", {
        words: intent.targetName ?? (intent.type === "update_task" ? null : intent.title) ?? intent.title,
      });
      if (!found.ok) return found.result;
      const task = found.item;
      if (intent.type === "complete_task") return { status: "ready", intent, spec: { kind: "task_complete", task } };
      if (intent.type === "remove_task") return { status: "ready", intent, spec: { kind: "task_remove", task } };
      const patch: Extract<ActionSpec, { kind: "task_update" }>["patch"] = {};
      if (intent.targetName && intent.title && normalizeText(intent.title) !== normalizeText(task.title)) patch.title = intent.title;
      const due = resolveDateRef(intent.deadline ?? intent.date, world.todayKey, world.weekStartsOn);
      if (due) {
        patch.dueDate = due;
        patch.dueTime = intent.deadlineTime;
      }
      if (intent.priority) patch.priority = intent.priority;
      const minutes = intent.amountMinutes ?? intent.durationMinutes;
      if (minutes) patch.estimatedMinutes = minutes;
      if (!Object.keys(patch).length) {
        return needs(intent, "other", task.title, `What should I change about ${lower(task.title)}?`);
      }
      return { status: "ready", intent, spec: { kind: "task_update", task, patch } };
    }

    case "update_event":
      return assessEventUpdate(intent, world);

    case "confirm_action":
      return { status: "skip", intent, reason: "Handled by the action state." };

    case "create_habit": {
      if (!intent.title) return needs(intent, "other", "Habit", "What habit do you want to build?");
      const cadence = cadenceOf(intent);
      if (!cadence) {
        return needs(intent, "amount", intent.title, `How often do you want to ${lower(intent.title)}?`, [
          "Every day",
          "3 times a week",
          "Twice a week",
        ]);
      }
      return { status: "ready", intent, spec: { kind: "habit_create", title: intent.title, lifeAreaId: lifeAreaId(world, intent.area), cadence } };
    }

    case "update_habit": {
      const found = findTarget(intent, world, refs.habits, "habit");
      if (!found.ok) return found.result;
      const habit = found.item;
      const cadence = cadenceOf(intent);
      if (!cadence) return needs(intent, "amount", habit.title, `How often should ${lower(habit.title)} be?`, ["Every day", "3 times a week"]);
      return { status: "ready", intent, spec: { kind: "habit_update", habit, cadence } };
    }

    case "create_goal": {
      if (!intent.title) return needs(intent, "other", "Goal", "What's the goal?");
      return {
        status: "ready",
        intent,
        spec: {
          kind: "goal_create",
          title: intent.title,
          lifeAreaId: lifeAreaId(world, intent.area),
          targetDate: resolveDateRef(intent.targetDate ?? intent.deadline, world.todayKey, world.weekStartsOn),
          description: intent.details,
        },
      };
    }

    case "update_goal": {
      const found = findTarget(intent, world, refs.goals, "goal");
      if (!found.ok) return found.result;
      const goal = found.item;
      const targetDate = resolveDateRef(intent.targetDate ?? intent.deadline, world.todayKey, world.weekStartsOn);
      if (intent.progress === null && !targetDate) {
        return needs(intent, "amount", goal.title, `Roughly how far along is ${lower(goal.title)}, as a percent?`, ["25%", "50%", "75%"]);
      }
      return { status: "ready", intent, spec: { kind: "goal_update", goal, progress: intent.progress, targetDate } };
    }

    case "set_life_area": {
      const areaId = lifeAreaId(world, intent.area);
      if (!areaId) {
        return needs(intent, "other", intent.title ?? "Life area", "Which life area should it go in?", world.areas.slice(0, 4).map((a) => a.name));
      }
      const areaName = world.areas.find((a) => a.id === areaId)!.name;
      const ref = intent.targetRef ?? "";
      const lookup: [Map<string, { id: string; title: string }>, "tasks" | "commitments" | "habits" | "goals"][] = [
        [refs.tasks, "tasks"],
        [refs.events, "commitments"],
        [refs.blocks, "commitments"],
        [refs.habits, "habits"],
        [refs.goals, "goals"],
      ];
      for (const [map, table] of lookup) {
        const found = findByRef(map, ref || null, ref ? null : intent.title);
        if (found) return { status: "ready", intent, spec: { kind: "set_area", table, id: found.id, title: found.title, lifeAreaId: areaId, areaName } };
      }
      return needs(intent, "target", intent.title ?? "Item", "Which item should I move?");
    }

    case "update_preferences": {
      const p = intent.prefs;
      const protectedTime =
        p.protectedLabel && intent.startTime && intent.endTime
          ? { label: p.protectedLabel, days: intent.days.length ? intent.days : [...WEEKDAYS], start: intent.startTime, end: intent.endTime }
          : null;
      if (p.protectedLabel && !protectedTime) {
        return needs(intent, "time", p.protectedLabel, `What time should I keep free for ${lower(p.protectedLabel)}?`);
      }
      if (!p.dayStart && !p.dayEnd && !p.maxSessionMinutes && p.bufferMinutes === null && !protectedTime) {
        return { status: "skip", intent, reason: "No preference change found." };
      }
      return {
        status: "ready",
        intent,
        spec: {
          kind: "prefs",
          dayStart: p.dayStart,
          dayEnd: p.dayEnd,
          maxSessionMinutes: p.maxSessionMinutes,
          bufferMinutes: p.bufferMinutes,
          protectedTime,
        },
      };
    }

    case "save_fact": {
      if (!intent.title || !intent.factCategory) return { status: "skip", intent, reason: "Incomplete fact." };
      const attributes: ContextAttributes = {};
      if (intent.days.length) attributes.days = intent.days;
      if (intent.startTime) attributes.startTime = intent.startTime;
      if (intent.endTime) attributes.endTime = intent.endTime;
      if (intent.timesPerWeek) attributes.timesPerWeek = intent.timesPerWeek;
      if (intent.durationMinutes) attributes.durationMinutes = intent.durationMinutes;
      return {
        status: "ready",
        intent,
        spec: {
          kind: "fact",
          category: intent.factCategory,
          title: intent.title,
          details: intent.details,
          lifeAreaId: lifeAreaId(world, intent.area),
          attributes,
        },
      };
    }

    case "plan_time":
      return assessPlanTime(intent, world);

    case "remove_event": {
      const day = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
      const calendar = new Map<string, Commitment>([...refs.events, ...refs.blocks]);
      const words = intent.targetName ?? intent.title;
      // "Cancel all math tutoring": every event with that name goes.
      if (intent.scope === "all" && words && !PRONOUN.test(words)) {
        const matches = matchEvents([...calendar.values()], words);
        if (matches.length) return { status: "ready", intent, spec: { kind: "remove_event", events: matches, title: matches[0].title } };
      }
      const found = findTarget(intent, world, calendar, "event", { words, onDate: day });
      if (!found.ok) {
        // Tasks aren't on the calendar. If only a task matches, the user meant that.
        if (found.result.status === "skip" && words) {
          const task = resolveEntity(refs.tasks, null, words);
          if (task.kind === "one") return { status: "ready", intent, spec: { kind: "task_remove", task: task.item } };
        }
        return found.result;
      }
      const event = found.item;
      // "Cancel my practice tomorrow" on a repeating event: only that day.
      if (event.recurrenceRule && (day || intent.scope === "one")) {
        const date = day ?? nextOccurrence(event, world.todayKey, world.timeZone);
        if (date && occursOn(event, date, world.timeZone)) {
          const isBlock = refs.blocks.has(found.ref);
          return {
            status: "ready",
            intent,
            spec: { kind: "cant_make", date, blocks: isBlock ? [event] : [], event: isBlock ? null : event, title: event.title },
          };
        }
        if (date) return { status: "skip", intent, reason: "Not that day.", note: `${event.title} doesn't happen on ${shortDate(date)}, so nothing was changed.` };
      }
      return { status: "ready", intent, spec: { kind: "remove_event", events: [event], title: event.title } };
    }

    case "cant_make": {
      const date = resolveDateRef(intent.date, world.todayKey, world.weekStartsOn);
      const block = intent.targetRef ? refs.blocks.get(intent.targetRef) ?? null : null;
      const event = intent.targetRef ? refs.events.get(intent.targetRef) ?? null : null;
      const title = intent.title ?? block?.title ?? event?.title ?? "that";
      if (!date && !block && !event) return needs(intent, "date", title, `Which day can't you make ${lower(title)}?`);
      // Sessions on that day whose title matches (or every session that day when no title was given).
      const n = intent.title ? normalizeText(intent.title) : null;
      const blocks = block
        ? [block]
        : [...refs.blocks.values()].filter((b) => {
            if (!b.startsAt) return false;
            const sameDay = date ? b.startsAt && localDate(b.startsAt, world.timeZone) === date : true;
            const matchesTitle = !n || n.split(" ").some((w) => w.length > 2 && normalizeText(b.title).includes(w));
            return sameDay && matchesTitle;
          });
      return { status: "ready", intent, spec: { kind: "cant_make", date, blocks, event, title } };
    }

    case "finished_early": {
      const words = intent.targetName ?? intent.title;
      if (!words && !intent.targetRef) return needs(intent, "target", "Task", "What did you finish?", candidates(refs.tasks, null));
      const found = findTarget(intent, world, refs.tasks, "task", { words });
      // No task by that name: only matching sessions are freed up, nothing is marked done.
      if (!found.ok && found.result.status === "needs") return found.result;
      const task = found.ok ? found.item : null;
      if (!task && !words) return needs(intent, "target", "Task", "What did you finish?", candidates(refs.tasks, null));
      return { status: "ready", intent, spec: { kind: "finished_early", task, title: task?.title ?? words! } };
    }

    case "not_enough_time":
      return { status: "ready", intent, spec: { kind: "not_enough_time", window: intent.window ?? "this_week" } };

    case "cancel_draft":
      return { status: "skip", intent, reason: "Cancelled." };
  }
}

/** Events whose title matches: exact first, else containment, else shared words. */
function matchEvents(events: Commitment[], title: string): Commitment[] {
  const n = normalizeText(title);
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const exact = unique.filter((e) => normalizeText(e.title) === n);
  if (exact.length) return exact;
  const contains = unique.filter((e) => {
    const t = normalizeText(e.title);
    return t.includes(n) || n.includes(t);
  });
  if (contains.length) return contains;
  const words = n.split(" ").filter((w) => w.length > 3);
  return words.length ? unique.filter((e) => words.every((w) => normalizeText(e.title).includes(w))) : [];
}

function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
