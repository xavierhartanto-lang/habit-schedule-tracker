import type { Commitment, LifeArea } from "@/lib/domain/types";
import { addDays } from "@/lib/scheduling/time";

type Template = {
  title: string;
  area: LifeArea;
  kind: "fixed" | "flexible";
  /** 0 = Monday */
  days: number[];
  start: string;
  end: string;
  location?: string;
};

const TEMPLATES: Template[] = [
  { title: "School day", area: "academics", kind: "fixed", days: [0, 1, 2, 3, 4], start: "08:00", end: "15:00", location: "Lincoln High" },
  { title: "Varsity swim practice", area: "athletics", kind: "fixed", days: [0, 2, 4], start: "15:30", end: "17:30", location: "Aquatic center" },
  { title: "Debate club", area: "extracurricular", kind: "fixed", days: [1], start: "15:30", end: "17:00", location: "Room 214" },
  { title: "Robotics build session", area: "extracurricular", kind: "fixed", days: [3], start: "15:30", end: "18:00", location: "Engineering lab" },
  { title: "Violin lesson", area: "creative", kind: "fixed", days: [1], start: "18:30", end: "19:30" },
  { title: "AP Chem problem set", area: "academics", kind: "flexible", days: [0], start: "19:30", end: "21:00" },
  { title: "College essay draft", area: "personal", kind: "flexible", days: [2], start: "19:00", end: "20:30" },
  { title: "SAT practice section", area: "academics", kind: "flexible", days: [5], start: "10:00", end: "11:30" },
  { title: "Swim meet", area: "athletics", kind: "fixed", days: [5], start: "13:00", end: "17:00", location: "Westview pool" },
  { title: "Violin practice", area: "creative", kind: "flexible", days: [3, 6], start: "19:30", end: "20:15" },
  { title: "Read for AP Lit", area: "academics", kind: "flexible", days: [6], start: "15:00", end: "16:30" },
  { title: "Sunday reset", area: "rest", kind: "flexible", days: [6], start: "18:00", end: "18:45" },
];

function at(day: Date, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** Sample week of commitments anchored to a Monday. */
export function buildSampleWeek(monday: Date): Commitment[] {
  return TEMPLATES.flatMap((t, ti) =>
    t.days.map((offset) => {
      const day = addDays(monday, offset);
      return {
        id: `sample-${ti}-${offset}`,
        title: t.title,
        area: t.area,
        kind: t.kind,
        startsAt: at(day, t.start),
        endsAt: at(day, t.end),
        location: t.location ?? null,
      } satisfies Commitment;
    }),
  );
}

/** Upcoming one-off commitments, expressed as days from today. */
export const SAMPLE_UPCOMING = [
  { id: "u1", title: "AP Chemistry unit test", area: "academics" as const, inDays: 2, time: "9:10 AM", kind: "fixed" as const },
  { id: "u2", title: "Debate tournament registration closes", area: "extracurricular" as const, inDays: 3, time: "11:59 PM", kind: "fixed" as const },
  { id: "u3", title: "Swim meet vs. Westview", area: "athletics" as const, inDays: 5, time: "1:00 PM", kind: "fixed" as const },
  { id: "u4", title: "Common App essay: second draft", area: "personal" as const, inDays: 6, time: "Flexible", kind: "flexible" as const },
];
