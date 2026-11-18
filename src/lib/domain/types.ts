/**
 * Core domain model. These types are shared by the UI, the database layer,
 * the scheduling engine and (later) the AI context builder.
 * They are deliberately independent of Supabase row shapes.
 */

export type LifeArea =
  | "academics"
  | "extracurricular"
  | "athletics"
  | "creative"
  | "personal"
  | "rest";

/**
 * fixed    = happens at a set time and cannot move (class, practice, exam).
 * flexible = needs time this week but the user or the scheduler can place it.
 */
export type CommitmentKind = "fixed" | "flexible";

export type Commitment = {
  id: string;
  title: string;
  area: LifeArea;
  kind: CommitmentKind;
  /** ISO datetime. Flexible items may be unplaced (null) until scheduled. */
  startsAt: string | null;
  endsAt: string | null;
  /** For flexible work: how long it needs in total. */
  estimatedMinutes?: number | null;
  /** For flexible work: latest point it must be done by. */
  dueAt?: string | null;
  location?: string | null;
};

export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "done";

export type Task = {
  id: string;
  title: string;
  area: LifeArea;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  estimatedMinutes: number | null;
};

export type HabitCadence = { type: "daily" } | { type: "weekly"; timesPerWeek: number };

export type Habit = {
  id: string;
  title: string;
  area: LifeArea;
  cadence: HabitCadence;
  /** ISO dates (YYYY-MM-DD) the habit was completed in the current week. */
  completedOn: string[];
};

export type GoalStatus = "active" | "paused" | "completed";

export type Goal = {
  id: string;
  title: string;
  area: LifeArea;
  description: string | null;
  targetDate: string | null;
  status: GoalStatus;
  milestones: { id: string; title: string; done: boolean }[];
};

export type Profile = {
  id: string;
  displayName: string | null;
  gradeLevel: number | null;
  school: string | null;
  timezone: string;
};

export type Preferences = {
  weekStartsOn: 0 | 1;
  dayStartTime: string; // "07:00"
  dayEndTime: string; // "22:30"
  aiPersonalizationEnabled: boolean;
  aiMemoryEnabled: boolean;
  shareUsageAnalytics: boolean;
};
