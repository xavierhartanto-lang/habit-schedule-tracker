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

/** A user-defined life area (Academics, Sports…). See lib/domain/life-areas. */
export type AreaColor =
  | "blue"
  | "violet"
  | "green"
  | "amber"
  | "pink"
  | "slate"
  | "teal"
  | "orange"
  | "cyan"
  | "brown";

export type LifeAreaRecord = {
  id: string;
  name: string;
  color: AreaColor;
  position: number;
  /** The old fixed category this area stands for, if any. */
  legacyKey: LifeArea | null;
};

/**
 * A calendar event. Stored in the `commitments` table.
 * fixed = holds its time; flexible = an activity that could move.
 */
export type Commitment = {
  id: string;
  title: string;
  /** Legacy fixed category, mirrored from the life area. Prefer lifeAreaId. */
  area: LifeArea | null;
  lifeAreaId?: string | null;
  kind: CommitmentKind;
  /** ISO datetime. Flexible items may be unplaced (null) until scheduled. */
  startsAt: string | null;
  endsAt: string | null;
  /** For flexible work: how long it needs in total. */
  estimatedMinutes?: number | null;
  /** For flexible work: latest point it must be done by. */
  dueAt?: string | null;
  location?: string | null;
  /** RFC 5545 RRULE for repeating commitments, e.g. FREQ=WEEKLY;BYDAY=MO,WE. */
  recurrenceRule?: string | null;
  /** The event description. */
  notes?: string | null;
  source?: DataSource;
  allDay?: boolean;
  /** IANA zone the event repeats in. Null = the user's profile zone. */
  timezone?: string | null;
  /** Local dates (YYYY-MM-DD) removed from a recurring series. */
  recurrenceExceptions?: string[];
};

export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "done";

export type Task = {
  id: string;
  title: string;
  area: LifeArea | null;
  lifeAreaId?: string | null;
  description?: string | null;
  goalId?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  estimatedMinutes: number | null;
  completedAt?: string | null;
  createdAt?: string;
};

export type HabitCadence =
  | { type: "daily" }
  | { type: "weekly"; timesPerWeek: number }
  | { type: "specific_days"; days: Weekday[] };

export type Habit = {
  id: string;
  title: string;
  area: LifeArea | null;
  lifeAreaId?: string | null;
  description?: string | null;
  cadence: HabitCadence;
  /** ISO dates (YYYY-MM-DD) the habit was completed in the loaded range. */
  completedOn: string[];
  createdAt?: string;
};

export type GoalStatus = "active" | "paused" | "completed";
export type GoalHorizon = "short_term" | "long_term";

export type Goal = {
  id: string;
  title: string;
  area: LifeArea | null;
  lifeAreaId?: string | null;
  /** Manual progress, 0-100. */
  progress?: number;
  description: string | null;
  targetDate: string | null;
  status: GoalStatus;
  milestones: { id: string; title: string; done: boolean }[];
  horizon?: GoalHorizon | null;
  source?: DataSource;
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

// ---------- Phase 2: personal understanding ----------

/**
 * Where a saved fact came from.
 * conversation = the user said it in a chat and confirmed saving it.
 * manual       = the user typed it into a form.
 */
export type DataSource = "conversation" | "manual";

/**
 * Things the assistant learns that do not belong in commitments or goals.
 * Fixed-time obligations (school, practice) are commitments; goals are goals.
 */
export type ContextCategory =
  | "activity" // ongoing involvement without a fixed slot (robotics club, volunteering)
  | "interest" // hobbies and personal interests
  | "routine" // repeated patterns (sleep, gym mornings, commute)
  | "working_time" // when the user likes to do focused work
  | "preference"; // other scheduling preferences ("no work after 10pm")

export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  "activity",
  "interest",
  "routine",
  "working_time",
  "preference",
];

export type Weekday = "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";

export const WEEKDAYS: readonly Weekday[] = ["mo", "tu", "we", "th", "fr", "sa", "su"];

/** Optional structure on a context item. Every field is optional. */
export type ContextAttributes = {
  days?: Weekday[];
  /** Local time "HH:MM" (24h). */
  startTime?: string;
  endTime?: string;
  timesPerWeek?: number;
  durationMinutes?: number;
};

export type ContextItem = {
  id: string;
  category: ContextCategory;
  title: string;
  details: string | null;
  area: LifeArea | null;
  lifeAreaId?: string | null;
  attributes: ContextAttributes;
  source: DataSource;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationKind = "onboarding" | "assistant";

export type Conversation = {
  id: string;
  kind: ConversationKind;
  title: string | null;
  /** Short recap reused as memory in later conversations. */
  summary: string | null;
  lastMessageAt: string;
  createdAt: string;
};

export type MessageRole = "user" | "assistant";

/** Structured extras on a message (e.g. proposed facts and their state). */
export type MessageMetadata = { [key: string]: JsonValue };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: MessageMetadata;
  createdAt: string;
};
