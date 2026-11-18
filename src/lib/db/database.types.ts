/**
 * Hand-written to match supabase/migrations/0001_initial_schema.sql.
 * Once a Supabase project is linked, replace with generated types:
 *   npx supabase gen types typescript --linked > src/lib/db/database.types.ts
 */

type Timestamps = { created_at: string; updated_at: string };

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Partial<Row> & Pick<Row, Required>;
  Update: Partial<Row>;
  Relationships: [];
};

export type LifeAreaEnum =
  | "academics"
  | "extracurricular"
  | "athletics"
  | "creative"
  | "personal"
  | "rest";

export type ProfileRow = Timestamps & {
  id: string;
  display_name: string | null;
  grade_level: number | null;
  school: string | null;
  timezone: string;
  onboarded_at: string | null;
};

export type PreferencesRow = Timestamps & {
  user_id: string;
  week_starts_on: number;
  day_start_time: string;
  day_end_time: string;
  ai_personalization_enabled: boolean;
  ai_memory_enabled: boolean;
  share_usage_analytics: boolean;
};

export type CommitmentRow = Timestamps & {
  id: string;
  user_id: string;
  title: string;
  area: LifeAreaEnum;
  kind: "fixed" | "flexible";
  starts_at: string | null;
  ends_at: string | null;
  recurrence_rule: string | null;
  estimated_minutes: number | null;
  due_at: string | null;
  location: string | null;
  notes: string | null;
};

export type TaskRow = Timestamps & {
  id: string;
  user_id: string;
  commitment_id: string | null;
  goal_id: string | null;
  title: string;
  area: LifeAreaEnum;
  priority: "high" | "medium" | "low";
  status: "todo" | "in_progress" | "done";
  due_at: string | null;
  estimated_minutes: number | null;
  completed_at: string | null;
};

export type HabitRow = Timestamps & {
  id: string;
  user_id: string;
  title: string;
  area: LifeAreaEnum;
  cadence: "daily" | "weekly";
  times_per_week: number | null;
  archived_at: string | null;
};

export type HabitLogRow = {
  id: string;
  user_id: string;
  habit_id: string;
  logged_on: string;
  created_at: string;
};

export type GoalRow = Timestamps & {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  area: LifeAreaEnum;
  target_date: string | null;
  status: "active" | "paused" | "completed";
};

export type GoalMilestoneRow = Timestamps & {
  id: string;
  user_id: string;
  goal_id: string;
  title: string;
  position: number;
  done_at: string | null;
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, "id">;
      user_preferences: Table<PreferencesRow, "user_id">;
      commitments: Table<CommitmentRow, "user_id" | "title" | "area" | "kind">;
      tasks: Table<TaskRow, "user_id" | "title" | "area">;
      habits: Table<HabitRow, "user_id" | "title" | "area" | "cadence">;
      habit_logs: Table<HabitLogRow, "user_id" | "habit_id" | "logged_on">;
      goals: Table<GoalRow, "user_id" | "title" | "area">;
      goal_milestones: Table<GoalMilestoneRow, "user_id" | "goal_id" | "title">;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      life_area: LifeAreaEnum;
    };
    CompositeTypes: Record<string, never>;
  };
};
