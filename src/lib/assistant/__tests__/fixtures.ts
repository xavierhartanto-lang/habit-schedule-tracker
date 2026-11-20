import type { Commitment, LifeAreaRecord, Task } from "@/lib/domain/types";
import { defaultSchedulingPreferences } from "@/lib/scheduling/planner";
import { zonedToUtc } from "@/lib/scheduling/zoned";
import type { RefTable, World } from "../assess";
import { PlannerWireSchema, toIntent, type Intent } from "../intents";

export const TZ = "America/Los_Angeles";
/** Wednesday, Nov 18 2026, 4:00 PM in Los Angeles. */
export const NOW = zonedToUtc("2026-11-18", "16:00", TZ);
export const TODAY = "2026-11-18";

export const AREAS: LifeAreaRecord[] = [
  { id: "00000000-0000-4000-8000-0000000000a1", name: "Academics", color: "blue", position: 0, legacyKey: "academics" },
  { id: "00000000-0000-4000-8000-0000000000a2", name: "Sports", color: "green", position: 1, legacyKey: "athletics" },
  { id: "00000000-0000-4000-8000-0000000000a3", name: "Hobbies", color: "amber", position: 2, legacyKey: "creative" },
];

export const PREFS = defaultSchedulingPreferences({ dayStartTime: "07:00", dayEndTime: "22:30" });

let n = 0;
export function uuid(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function event(partial: Partial<Commitment> & { title: string; date: string; start: string; end: string }): Commitment {
  const { date, start, end, ...rest } = partial;
  return {
    id: uuid(),
    area: null,
    kind: "fixed",
    startsAt: zonedToUtc(date, start, TZ).toISOString(),
    endsAt: zonedToUtc(date, end, TZ).toISOString(),
    timezone: TZ,
    recurrenceRule: null,
    ...rest,
  };
}

export function task(partial: Partial<Task> & { title: string }): Task {
  return {
    id: uuid(),
    area: null,
    priority: "medium",
    status: "todo",
    dueAt: null,
    estimatedMinutes: null,
    ...partial,
  };
}

/** School every weekday 8:00-15:00 and volleyball Thursdays 18:00-20:00, starting in September. */
export function weekCalendar(): Commitment[] {
  return [
    event({ title: "School", date: "2026-09-01", start: "08:00", end: "15:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" }),
    event({ title: "Volleyball", date: "2026-09-03", start: "18:00", end: "20:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=TH" }),
  ];
}

export function emptyRefs(): RefTable {
  return { tasks: new Map(), events: new Map(), blocks: new Map(), habits: new Map(), goals: new Map() };
}

export function world(refs: RefTable = emptyRefs()): World {
  return { todayKey: TODAY, timeZone: TZ, weekStartsOn: 1, areas: AREAS, refs };
}

type WireIntent = Parameters<typeof toIntent>[0];

/** A wire intent with every field null/empty, then the overrides. */
export function wire(overrides: Partial<WireIntent> & Pick<WireIntent, "type" | "evidence">): WireIntent {
  return {
    draft_id: null,
    explicit: false,
    title: null,
    area: null,
    target_ref: null,
    target_name: null,
    date: null,
    start_time: null,
    start_in_minutes: null,
    end_time: null,
    duration_minutes: null,
    recurrence: null,
    days: [],
    deadline: null,
    deadline_time: null,
    amount_kind: null,
    amount_minutes: null,
    session_count: null,
    session_minutes: null,
    window: null,
    priority: null,
    cadence: null,
    times_per_week: null,
    progress: null,
    target_date: null,
    location: null,
    scope: null,
    fact_category: null,
    details: null,
    pref_day_start: null,
    pref_day_end: null,
    pref_max_session_minutes: null,
    pref_buffer_minutes: null,
    pref_protected_label: null,
    ...overrides,
  };
}

export function intent(overrides: Partial<WireIntent> & Pick<WireIntent, "type" | "evidence">): Intent {
  return toIntent(PlannerWireSchema.shape.intents.element.parse(wire(overrides)));
}

export const date = (d: Partial<{ iso_date: string | null; weekday: WireIntent["days"][number] | null; week: "this" | "next" | null; day_offset: number | null }>) => ({
  iso_date: null,
  weekday: null,
  week: null,
  day_offset: null,
  ...d,
});
