/**
 * The assistant's opening line on Home, built only from the user's real
 * data. No LLM call: it must work when the AI is down, load instantly,
 * and never mention a commitment that doesn't exist. Pure, so it is tested.
 */

export type OpeningEvent = { title: string; start: string; end: string; allDay: boolean };

export type OpeningDeadline = {
  title: string;
  /** "task" = a task due date, "event" = a fixed calendar commitment. */
  kind: "task" | "event";
  /** Days from today in the user's time zone. Negative = overdue. */
  days: number;
  /** Weekday name in the user's time zone, e.g. "Friday". */
  weekday: string;
  /** Short date, e.g. "Nov 27". */
  date: string;
  priority?: "high" | "medium" | "low";
};

export type OpeningInput = {
  firstName: string | null;
  /** Local hour in the user's time zone (0–23). */
  hour: number;
  /** ISO weekday in the user's time zone: 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
  /** Today's events that haven't ended yet, in order. Times already formatted. */
  remainingToday: (OpeningEvent & { time: string })[];
  /** Due dates and fixed commitments from overdue through the next ~2 weeks. */
  deadlines: OpeningDeadline[];
  /** True when the user has no events and no open tasks at all. */
  empty: boolean;
};

export type Starter = {
  label: string;
  /** What gets sent as the user's message. */
  prompt: string;
  checkIn?: "daily" | "weekly";
};

export type Opening = {
  greeting: string;
  message: string;
  starters: Starter[];
  /** Starters that don't depend on the opening line's topic (used when a proactive line leads). */
  generalStarters: Starter[];
};

const STUDY_RE = /\b(exam|test|quiz|midterm|final|finals|sat|act|ap|psat|ib)\b/i;

export function partOfDay(hour: number): string {
  if (hour < 5) return "Late night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** "today", "tomorrow", "on Friday", "next Friday", "on Nov 27". */
export function whenPhrase(d: Pick<OpeningDeadline, "days" | "weekday" | "date">): string {
  if (d.days === 0) return "today";
  if (d.days === 1) return "tomorrow";
  if (d.days < 7) return `on ${d.weekday}`;
  return `on ${d.weekday}, ${d.date}`;
}

const isStudy = (title: string) => STUDY_RE.test(title);

/** The deadline most worth raising: overdue first, then study items, then high priority, then soonest. */
export function pickFocus(deadlines: OpeningDeadline[]): OpeningDeadline | null {
  const overdue = deadlines.filter((d) => d.kind === "task" && d.days < 0).sort((a, b) => b.days - a.days);
  if (overdue.length) return overdue[0];
  // Events only matter here when they need preparation (an exam); a dentist visit doesn't need "time blocked".
  const upcoming = deadlines.filter((d) => d.days >= 0 && d.days <= 13 && (d.kind === "task" || isStudy(d.title)));
  const rank = (d: OpeningDeadline) =>
    (isStudy(d.title) ? 0 : d.priority === "high" ? 1 : d.kind === "task" ? 2 : 3) * 100 + d.days;
  const sorted = [...upcoming].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  if (!best) return null;
  // A routine event or low-stakes task far away isn't worth opening with.
  if (!isStudy(best.title) && best.priority !== "high" && best.days > 3) return null;
  return best;
}

export function buildOpening(input: OpeningInput): Opening {
  const hello = partOfDay(input.hour);
  const greeting = input.firstName ? `${hello}, ${input.firstName}` : hello;
  const weekStart = input.isoWeekday === 7 || input.isoWeekday === 1;
  const evening = input.hour >= 18;

  const plan: Starter = evening
    ? { label: "Plan tomorrow", prompt: "Help me plan tomorrow.", checkIn: "daily" }
    : { label: "Plan my day", prompt: "Help me plan my day.", checkIn: "daily" };
  const week: Starter = {
    label: input.isoWeekday === 7 ? "Plan next week" : "Plan my week",
    prompt: input.isoWeekday === 7 ? "Help me plan next week." : "Help me plan my week.",
    checkIn: "weekly",
  };
  const changed: Starter = { label: "Something changed", prompt: "Something in my schedule changed." };
  const add: Starter = { label: "Add a commitment", prompt: "I have a new commitment to add." };

  if (input.empty) {
    return {
      greeting,
      message:
        "Blank calendar. Let's fix that. Walk me through a normal week: school, practices, lessons, anything that repeats.",
      starters: [
        { label: "My weekly routine", prompt: "Let me tell you about a normal week for me." },
        { label: "An upcoming deadline", prompt: "I have a deadline coming up." },
        week,
      ],
      generalStarters: [week, changed, add],
    };
  }

  const focus = pickFocus(input.deadlines);
  const starters: Starter[] = [];
  let message: string;

  if (focus && focus.days < 0) {
    const ago = focus.days === -1 ? "yesterday" : `${-focus.days} days ago`;
    message = `“${focus.title}” was due ${ago}. Want me to find time, or is it done?`;
    starters.push({ label: `Reschedule ${focus.title}`, prompt: `Help me find time to finish “${focus.title}”.` });
  } else if (focus && isStudy(focus.title)) {
    message = `${focus.title} is ${whenPhrase(focus)}. Want me to plan study time?`;
    starters.push({
      label: "Plan study time",
      prompt: `Help me plan study time for ${focus.title} ${whenPhrase(focus)}.`,
    });
  } else if (focus) {
    const verb = focus.kind === "task" ? "is due" : "is";
    message = `“${focus.title}” ${verb} ${whenPhrase(focus)}. Want me to block out time?`;
    starters.push({ label: "Block time for it", prompt: `Help me block out time for “${focus.title}”.` });
  } else if (weekStart && !evening) {
    message = "New week. What's the big thing coming up?";
  } else if (input.remainingToday.length > 0) {
    const next = input.remainingToday[0];
    const n = input.remainingToday.length;
    const lead = next.allDay ? `“${next.title}” today` : `“${next.title}” at ${next.time}`;
    message =
      n === 1
        ? `Next up: ${lead}. What else needs doing today?`
        : `${n} things left today. First up: ${lead}. What else needs doing?`;
  } else if (evening) {
    message = "Today's clear. Want a head start on tomorrow?";
  } else {
    message = "Clear calendar today. What do you want out of it?";
  }

  const general = weekStart ? [week, plan, changed, add] : [plan, week, changed, add];
  starters.push(...general);
  return { greeting, message, starters: starters.slice(0, 4), generalStarters: general };
}
