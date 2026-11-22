import type { Commitment, Task } from "@/lib/domain/types";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import { newId, state } from "./fake-db";

/**
 * A busy high schooler's week, the way it looks in Whitespace:
 * school and practices that repeat, Google Calendar events (read-only),
 * one-off appointments, tasks with priorities and optional due dates, and
 * work sessions Whitespace scheduled for those tasks.
 *
 * Today is Wednesday 2026-11-18, 4:00 PM in Los Angeles (week starts Monday).
 */

export const TZ = "America/Los_Angeles";
export const NOW = zonedToUtc("2026-11-18", "16:00", TZ);

export const at = (day: string, time: string) => zonedToUtc(day, time, TZ).toISOString();

type EventInput = {
  title: string;
  day: string;
  start: string;
  end: string;
  rrule?: string | null;
  google?: boolean;
  session?: { task: Task | null };
  location?: string;
};

export function addEvent(e: EventInput): Commitment {
  const ev: Commitment = {
    id: newId(),
    title: e.title,
    area: null,
    kind: e.session ? "flexible" : "fixed",
    startsAt: at(e.day, e.start),
    endsAt: at(e.day, e.end),
    timezone: TZ,
    recurrenceRule: e.rrule ?? null,
    recurrenceExceptions: [],
    location: e.location ?? null,
    source: e.google ? "import" : "manual",
    externalSource: e.google ? "google" : null,
    ...(e.session ? { planItemId: newId(), taskId: e.session.task?.id ?? null } : {}),
  } as Commitment;
  state.db.events.push(ev);
  return ev;
}

export function addTask(title: string, priority: Task["priority"], opts: { due?: string; minutes?: number } = {}): Task {
  const t: Task = {
    id: newId(),
    title,
    area: null,
    priority,
    status: "todo",
    dueAt: opts.due ? at(opts.due, "23:59") : null,
    estimatedMinutes: opts.minutes ?? null,
  };
  state.db.tasks.push(t);
  return t;
}

export type Seed = ReturnType<typeof seedWeek>;

export function seedWeek() {
  // Tasks: priority-first, due dates optional.
  const chem = addTask("Chemistry Homework", "high", { due: "2026-11-19", minutes: 90 });
  const essay = addTask("History Essay", "high", { due: "2026-11-23", minutes: 240 });
  const spanish = addTask("Spanish Vocab", "low", { minutes: 30 });
  const college = addTask("College Essay Draft", "medium", { minutes: 120 });
  const physics = addTask("Physics Problem Set", "medium", { due: "2026-11-24", minutes: 60 });

  return {
    chem,
    essay,
    spanish,
    college,
    physics,
    // Repeating, made in Whitespace.
    school: addEvent({ title: "School", day: "2026-09-01", start: "08:00", end: "15:00", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" }),
    basketball: addEvent({ title: "Basketball Practice", day: "2026-09-01", start: "17:00", end: "19:00", rrule: "FREQ=WEEKLY;BYDAY=TU,TH" }),
    piano: addEvent({ title: "Piano Lesson", day: "2026-09-02", start: "18:30", end: "19:15", rrule: "FREQ=WEEKLY;BYDAY=WE" }),
    // From Google Calendar: read-only.
    debate: addEvent({ title: "Debate Club", day: "2026-09-05", start: "10:00", end: "12:00", rrule: "FREQ=WEEKLY;BYDAY=SA", google: true }),
    labReview: addEvent({ title: "Chemistry Lab Review", day: "2026-11-19", start: "15:30", end: "16:30", google: true }),
    familyDinner: addEvent({ title: "Family Dinner", day: "2026-11-22", start: "18:00", end: "20:00", google: true }),
    // One-offs made in Whitespace.
    dentist: addEvent({ title: "Dentist Appointment", day: "2026-11-20", start: "16:00", end: "17:00" }),
    tutoring: addEvent({ title: "Math Tutoring", day: "2026-11-19", start: "19:30", end: "20:30" }),
    satPractice: addEvent({ title: "SAT Practice Test", day: "2026-11-22", start: "09:00", end: "12:00" }),
    robotics: addEvent({ title: "Robotics Meeting", day: "2026-11-19", start: "15:30", end: "16:30" }),
    // Work sessions Whitespace scheduled.
    chemSession: addEvent({ title: "Chemistry Homework", day: "2026-11-18", start: "19:30", end: "21:00", session: { task: chem } }),
    essaySession1: addEvent({ title: "History Essay", day: "2026-11-19", start: "20:45", end: "21:45", session: { task: essay } }),
    essaySession2: addEvent({ title: "History Essay", day: "2026-11-20", start: "19:00", end: "20:30", session: { task: essay } }),
    spanishSession: addEvent({ title: "Spanish Vocab", day: "2026-11-20", start: "17:30", end: "18:00", session: { task: spanish } }),
    collegeSession: addEvent({ title: "College Essay Draft", day: "2026-11-21", start: "14:00", end: "16:00", session: { task: college } }),
  };
}
