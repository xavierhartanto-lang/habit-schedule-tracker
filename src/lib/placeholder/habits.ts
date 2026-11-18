import type { Goal, Habit } from "@/lib/domain/types";

/** completedOn holds weekday offsets (0 = Monday); the UI maps them to dates. */
export const SAMPLE_HABITS: (Omit<Habit, "completedOn"> & { doneOffsets: number[] })[] = [
  { id: "h1", title: "Sleep by 11:00 PM", area: "rest", cadence: { type: "daily" }, doneOffsets: [0, 1, 3] },
  { id: "h2", title: "Violin practice, 30 min", area: "creative", cadence: { type: "weekly", timesPerWeek: 5 }, doneOffsets: [0, 1, 2] },
  { id: "h3", title: "Review flashcards", area: "academics", cadence: { type: "daily" }, doneOffsets: [0, 1, 2, 3] },
  { id: "h4", title: "Stretch and mobility", area: "athletics", cadence: { type: "weekly", timesPerWeek: 3 }, doneOffsets: [1] },
  { id: "h5", title: "Journal before bed", area: "personal", cadence: { type: "weekly", timesPerWeek: 4 }, doneOffsets: [0, 2] },
];

export const SAMPLE_GOALS: Goal[] = [
  {
    id: "g1",
    title: "Score 1500+ on the SAT",
    area: "academics",
    description: "Test date in March. Two practice sections a week.",
    targetDate: "2026-03-14",
    status: "active",
    milestones: [
      { id: "m1", title: "Diagnostic test", done: true },
      { id: "m2", title: "Finish math content review", done: true },
      { id: "m3", title: "Four full practice tests", done: false },
      { id: "m4", title: "Final review week", done: false },
    ],
  },
  {
    id: "g2",
    title: "Qualify for state in 200 free",
    area: "athletics",
    description: "Drop 1.5 seconds before the district meet.",
    targetDate: "2026-02-21",
    status: "active",
    milestones: [
      { id: "m5", title: "Consistent 5 practices/week", done: true },
      { id: "m6", title: "Hit 1:58 in a dual meet", done: false },
      { id: "m7", title: "Taper plan with coach", done: false },
    ],
  },
  {
    id: "g3",
    title: "Finish Common App personal essay",
    area: "personal",
    description: null,
    targetDate: "2026-08-01",
    status: "active",
    milestones: [
      { id: "m8", title: "Brainstorm three topics", done: true },
      { id: "m9", title: "First draft", done: false },
      { id: "m10", title: "Feedback from counselor", done: false },
    ],
  },
];
