import type { LifeArea } from "@/lib/domain/types";

export const SAMPLE_ALLOCATION: { area: LifeArea; minutes: number; lastWeek: number }[] = [
  { area: "academics", minutes: 2340, lastWeek: 2220 },
  { area: "athletics", minutes: 840, lastWeek: 720 },
  { area: "extracurricular", minutes: 390, lastWeek: 480 },
  { area: "creative", minutes: 210, lastWeek: 240 },
  { area: "personal", minutes: 180, lastWeek: 120 },
  { area: "rest", minutes: 90, lastWeek: 150 },
];

export const SAMPLE_DAILY_LOAD: { day: string; scheduledMinutes: number }[] = [
  { day: "Mon", scheduledMinutes: 630 },
  { day: "Tue", scheduledMinutes: 600 },
  { day: "Wed", scheduledMinutes: 660 },
  { day: "Thu", scheduledMinutes: 660 },
  { day: "Fri", scheduledMinutes: 540 },
  { day: "Sat", scheduledMinutes: 330 },
  { day: "Sun", scheduledMinutes: 225 },
];

/** Observations are hand-written samples, not AI output. */
export const SAMPLE_OBSERVATIONS = [
  {
    id: "o1",
    title: "Wednesday is your heaviest day",
    body: "Swim practice runs straight into essay time. There is no gap for dinner.",
  },
  {
    id: "o2",
    title: "Rest dropped 40% from last week",
    body: "Sunday reset was the only planned downtime.",
  },
  {
    id: "o3",
    title: "Flexible work clusters after 7 PM",
    body: "Most homework blocks land late in the evening on practice days.",
  },
];
