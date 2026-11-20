/**
 * Hand-written to match supabase/migrations (initial schema, personal understanding, core planning,
 * scheduling preferences).
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

export type GoalHorizonEnum = "short_term" | "long_term";
export type DataSourceEnum = "conversation" | "manual";
export type ConversationKindEnum = "onboarding" | "assistant";
export type MessageRoleEnum = "user" | "assistant";
export type ContextCategoryEnum = "activity" | "interest" | "routine" | "working_time" | "preference";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Provenance = { source: DataSourceEnum; source_message_id: string | null };

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

export type AreaColorEnum =
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

export type LifeAreaRow = Timestamps & {
  id: string;
  user_id: string;
  name: string;
  color: AreaColorEnum;
  position: number;
  legacy_key: LifeAreaEnum | null;
};

export type CommitmentRow = Timestamps & {
  id: string;
  user_id: string;
  title: string;
  area: LifeAreaEnum | null;
  life_area_id: string | null;
  all_day: boolean;
  timezone: string | null;
  recurrence_exceptions: string[];
  kind: "fixed" | "flexible";
  starts_at: string | null;
  ends_at: string | null;
  recurrence_rule: string | null;
  estimated_minutes: number | null;
  due_at: string | null;
  location: string | null;
  notes: string | null;
  task_id: string | null;
  plan_item_id: string | null;
  /** Phase 7 (20261128000000). Missing until that migration runs. */
  outcome?: "done" | "partial" | "missed" | null;
  outcome_at?: string | null;
  outcome_source?: "user" | "task_done" | null;
} & Provenance;

export type TaskRow = Timestamps & {
  id: string;
  user_id: string;
  commitment_id: string | null;
  goal_id: string | null;
  title: string;
  description: string | null;
  area: LifeAreaEnum | null;
  life_area_id: string | null;
  priority: "high" | "medium" | "low";
  status: "todo" | "in_progress" | "done";
  due_at: string | null;
  estimated_minutes: number | null;
  completed_at: string | null;
  /** Phase 5. */
  postpone_count?: number;
  last_postponed_at?: string | null;
  /** Phase 7.3 (optional until 20261129000000 has run). */
  parent_task_id?: string | null;
};

export type HabitRow = Timestamps & {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  area: LifeAreaEnum | null;
  life_area_id: string | null;
  cadence: "daily" | "weekly" | "specific_days";
  times_per_week: number | null;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: number[] | null;
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
  area: LifeAreaEnum | null;
  life_area_id: string | null;
  progress: number;
  target_date: string | null;
  status: "active" | "paused" | "completed";
  horizon: GoalHorizonEnum | null;
} & Provenance;

export type GoalMilestoneRow = Timestamps & {
  id: string;
  user_id: string;
  goal_id: string;
  title: string;
  position: number;
  done_at: string | null;
};

export type ConversationRow = Timestamps & {
  id: string;
  user_id: string;
  kind: ConversationKindEnum;
  title: string | null;
  summary: string | null;
  last_message_at: string;
  planning_state: Json;
};

export type MessageRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  role: MessageRoleEnum;
  content: string;
  metadata: Json;
  created_at: string;
};

export type ContextItemRow = Timestamps & {
  id: string;
  user_id: string;
  category: ContextCategoryEnum;
  title: string;
  details: string | null;
  area: LifeAreaEnum | null;
  life_area_id: string | null;
  attributes: Json;
} & Provenance;

export type SchedulingPreferencesRow = Timestamps & {
  user_id: string;
  working_hours: Json;
  protected_times: Json;
  min_session_minutes: number;
  max_session_minutes: number;
  buffer_minutes: number;
  daily_cap_minutes: number;
  keep_free_percent: number;
  /** Phase 5 assistant settings. */
  proactivity?: "minimal" | "balanced" | "proactive";
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
};

export type SchoolScheduleRow = Timestamps & {
  user_id: string;
  status: "saved" | "skipped";
  school: string | null;
  district: string | null;
  schedule: Json | null;
  commitment_ids: string[];
};

export type RecommendationRow = Timestamps & {
  id: string;
  user_id: string;
  dedupe_key: string;
  kind: string;
  priority: "high" | "medium" | "low";
  status: "open" | "proposed" | "snoozed" | "dismissed" | "acted" | "resolved";
  title: string;
  reason: string;
  message: string;
  facts: Json;
  actions: Json;
  task_id: string | null;
  commitment_ids: string[];
  target_date: string | null;
  plan_id: string | null;
  snoozed_until: string | null;
  last_shown_at: string | null;
  shown_count: number;
  last_seen_at: string;
  resolved_at: string | null;
};

export type WeeklyBriefingRow = Timestamps & {
  id: string;
  user_id: string;
  week_start: string;
  facts_hash: string;
  facts: Json;
  summary: string | null;
  generated_at: string;
  shown_at: string | null;
  dismissed_at: string | null;
};

export type PlanKindEnum = "actions" | "schedule" | "reschedule";
export type PlanStatusEnum = "pending" | "partially_applied" | "applied" | "rejected" | "stale";
export type PlanItemStatusEnum = "pending" | "applied" | "rejected" | "conflict" | "failed" | "undone";

export type PlanProposalRow = Timestamps & {
  id: string;
  user_id: string;
  conversation_id: string | null;
  message_id: string | null;
  source_message_id: string | null;
  kind: PlanKindEnum;
  status: PlanStatusEnum;
  summary: string | null;
  unscheduled: Json;
  context: Json;
  version: number;
  expires_at: string;
};

export type PlanItemRow = Timestamps & {
  id: string;
  user_id: string;
  proposal_id: string;
  position: number;
  action: string;
  status: PlanItemStatusEnum;
  auto_applied: boolean;
  title: string;
  payload: Json;
  display: Json;
  target_id: string | null;
  result_id: string | null;
  undo: Json | null;
  error: string | null;
  applied_at: string | null;
};

export type PlanApprovalRow = {
  user_id: string;
  request_id: string;
  proposal_id: string;
  result: Json;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, "id">;
      user_preferences: Table<PreferencesRow, "user_id">;
      life_areas: Table<LifeAreaRow, "user_id" | "name">;
      commitments: Table<CommitmentRow, "user_id" | "title" | "kind">;
      tasks: Table<TaskRow, "user_id" | "title">;
      habits: Table<HabitRow, "user_id" | "title" | "cadence">;
      habit_logs: Table<HabitLogRow, "user_id" | "habit_id" | "logged_on">;
      goals: Table<GoalRow, "user_id" | "title">;
      goal_milestones: Table<GoalMilestoneRow, "user_id" | "goal_id" | "title">;
      conversations: Table<ConversationRow, "user_id">;
      messages: Table<MessageRow, "user_id" | "conversation_id" | "role" | "content">;
      context_items: Table<ContextItemRow, "user_id" | "category" | "title">;
      scheduling_preferences: Table<SchedulingPreferencesRow, "user_id">;
      plan_proposals: Table<PlanProposalRow, "user_id" | "kind">;
      plan_items: Table<PlanItemRow, "user_id" | "proposal_id" | "position" | "action" | "title">;
      plan_approvals: Table<PlanApprovalRow, "user_id" | "request_id" | "proposal_id">;
      recommendations: Table<RecommendationRow, "user_id" | "dedupe_key" | "kind" | "priority" | "title" | "reason" | "message">;
      school_schedules: Table<SchoolScheduleRow, "user_id" | "status">;
      weekly_briefings: Table<WeeklyBriefingRow, "user_id" | "week_start" | "facts_hash">;
    };
    Views: Record<string, never>;
    Functions: {
      delete_life_area: {
        Args: { p_area_id: string; p_reassign_to?: string | null };
        Returns: undefined;
      };
      apply_plan_items: {
        Args: { p_proposal_id: string; p_request_id: string; p_ops: Json };
        Returns: Json;
      };
      undo_plan_item: {
        Args: { p_item_id: string };
        Returns: undefined;
      };
      save_school_schedule: {
        Args: { p_schedule: Json; p_school: string | null; p_district: string | null; p_blocks: Json };
        Returns: string[];
      };
    };
    Enums: {
      life_area: LifeAreaEnum;
      data_source: DataSourceEnum;
      goal_horizon: GoalHorizonEnum;
      conversation_kind: ConversationKindEnum;
      message_role: MessageRoleEnum;
      context_category: ContextCategoryEnum;
    };
    CompositeTypes: Record<string, never>;
  };
};
