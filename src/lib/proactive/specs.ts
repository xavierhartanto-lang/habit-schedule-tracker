import type { RecommendationAction } from "@/features/proactive/types";
import type { ActionSpec } from "@/lib/assistant/assess";
import type { Commitment, Task } from "@/lib/domain/types";
import { addDaysToKey, dateKeyInZone, isDateKey } from "@/lib/scheduling/zoned";
import { REQUEST_LIMITS } from "@/lib/scheduling/planner";

/**
 * Recommendation action -> Phase 4 action specs, so every change goes
 * through buildPlan, the scheduling engine and the approval card. Params
 * are re-validated against fresh records here: a stale or tampered id
 * produces an error, never a write. Pure.
 */

export type SpecContext = {
  todayKey: string;
  /** Fresh open tasks, by id. */
  tasks: Map<string, Task>;
  /** Fresh calendar rows, by id. */
  events: Map<string, Commitment>;
  maxSessionMinutes: number;
  nowMs: number;
  timeZone: string;
};

export type SpecResult =
  | { ok: true; specs: ActionSpec[]; prompt: null }
  | { ok: true; specs: []; prompt: string }
  | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
const clamp = (v: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, v));

function planTime(task: Task, amount: Extract<ActionSpec, { kind: "plan_time" }>["amount"], opts: Partial<Extract<ActionSpec, { kind: "plan_time" }>> = {}): ActionSpec {
  return {
    kind: "plan_time",
    title: task.title,
    amount,
    priority: task.priority,
    deadlineDate: null,
    deadlineTime: null,
    window: "until_deadline",
    preferredDays: [],
    taskId: task.id,
    lifeAreaId: task.lifeAreaId ?? null,
    ...opts,
  };
}

/** Deadline at the end of a local day, never cut short by an event that day. */
function endOf(date: string): { deadlineDate: string; deadlineTime: string } {
  return { deadlineDate: date, deadlineTime: "23:59" };
}

function isSession(e: Commitment | undefined): e is Commitment {
  return !!e && e.kind === "flexible" && !!e.planItemId && !!e.startsAt;
}

export function specsForAction(action: RecommendationAction, ctx: SpecContext): SpecResult {
  const p = action.params;
  const task = () => {
    const id = str(p.taskId);
    return id ? ctx.tasks.get(id) ?? null : null;
  };
  const gone = { ok: false as const, error: "That task is already done or no longer exists." };

  switch (action.kind) {
    case "ask": {
      const prompt = str(p.prompt)?.trim();
      return prompt ? { ok: true, specs: [], prompt: prompt.slice(0, 500) } : { ok: false, error: "Nothing to ask." };
    }
    case "schedule_work": {
      const t = task();
      if (!t) return gone;
      const minutes = num(p.minutes);
      if (!minutes) return { ok: false, error: "How long it needs is missing." };
      const before = str(p.before);
      const overdue = !!t.dueAt && Date.parse(t.dueAt) <= ctx.nowMs;
      let opts: Partial<Extract<ActionSpec, { kind: "plan_time" }>> = {};
      if (before && isDateKey(before) && before > ctx.todayKey) opts = endOf(addDaysToKey(before, -1));
      // Already late: finish within the next few days (the task's due date is not changed).
      else if (overdue || !t.dueAt) opts = endOf(addDaysToKey(ctx.todayKey, 6));
      return { ok: true, prompt: null, specs: [planTime(t, { type: "total", minutes: clamp(minutes, REQUEST_LIMITS.totalMinutes) }, opts)] };
    }
    case "split_sessions": {
      const t = task();
      if (!t) return gone;
      const count = num(p.sessions);
      const each = num(p.minutesEach);
      if (!count || !each) return { ok: false, error: "The session plan is missing." };
      const opts = !t.dueAt || Date.parse(t.dueAt) <= ctx.nowMs ? endOf(addDaysToKey(ctx.todayKey, 6)) : {};
      return {
        ok: true,
        prompt: null,
        specs: [planTime(t, { type: "sessions", count: clamp(count, REQUEST_LIMITS.sessionCount), minutesEach: clamp(each, REQUEST_LIMITS.sessionMinutes) }, opts)],
      };
    }
    case "reschedule":
    case "lighten_day": {
      const blocks = ids(p.commitmentIds).map((id) => ctx.events.get(id)).filter(isSession);
      if (!blocks.length) return { ok: false, error: "Those sessions have already changed. Refresh to see the latest." };
      const date = action.kind === "lighten_day" ? str(p.date) : null;
      if (date !== null && !isDateKey(date)) return { ok: false, error: "Unknown day." };
      return {
        ok: true,
        prompt: null,
        specs: [{ kind: "cant_make", date, blocks, event: null, title: blocks[0].title }],
      };
    }
    case "plan_day": {
      const date = str(p.date);
      if (!date || !isDateKey(date) || (date !== ctx.todayKey && date !== addDaysToKey(ctx.todayKey, 1))) {
        return { ok: false, error: "That day has passed. Refresh to plan today." };
      }
      const specs: ActionSpec[] = [];
      for (const id of ids(p.taskIds).slice(0, 3)) {
        const t = ctx.tasks.get(id);
        if (!t?.estimatedMinutes) continue;
        const minutes = clamp(Math.min(t.estimatedMinutes, ctx.maxSessionMinutes), REQUEST_LIMITS.totalMinutes);
        // Due later that day: finish before it's due. Overdue or due later: anywhere in that day.
        const dueThatDay = !!t.dueAt && Date.parse(t.dueAt) > ctx.nowMs && dateKeyInZone(new Date(t.dueAt), ctx.timeZone) === date;
        specs.push(planTime(t, { type: "total", minutes }, { window: date === ctx.todayKey ? "today" : "tomorrow", ...(dueThatDay ? {} : endOf(date)) }));
      }
      return specs.length ? { ok: true, prompt: null, specs } : { ok: false, error: "Nothing left to plan for that day." };
    }
    case "plan_week":
      return { ok: true, prompt: null, specs: [{ kind: "not_enough_time", window: "this_week" }] };
    case "schedule_tasks": {
      // Plan every task's remaining work in one engine call: the planner spreads it
      // over the free days before each deadline, so a cluster starts earlier on its own.
      const specs: ActionSpec[] = [];
      for (const id of ids(p.taskIds).slice(0, 6)) {
        const t = ctx.tasks.get(id);
        if (!t?.estimatedMinutes) continue;
        const opts = !t.dueAt || Date.parse(t.dueAt) <= ctx.nowMs ? endOf(addDaysToKey(ctx.todayKey, 6)) : {};
        specs.push(planTime(t, { type: "total", minutes: clamp(t.estimatedMinutes, REQUEST_LIMITS.totalMinutes) }, opts));
      }
      return specs.length ? { ok: true, prompt: null, specs } : { ok: false, error: "Those tasks are done or have no time estimate." };
    }
    case "resolve_conflict": {
      // The user picked which event is right. The other one goes, through an approval card:
      // a repeating event skips only that day, a one-off is removed (Undo brings it back).
      const drop = ctx.events.get(str(p.dropId) ?? "");
      const date = str(p.date);
      if (!drop || drop.kind !== "fixed" || drop.planItemId) return { ok: false, error: "That event has already changed. Refresh to see the latest." };
      if (drop.recurrenceRule) {
        if (!date || !isDateKey(date)) return { ok: false, error: "Unknown day." };
        return { ok: true, prompt: null, specs: [{ kind: "cant_make", date, blocks: [], event: drop, title: drop.title }] };
      }
      return { ok: true, prompt: null, specs: [{ kind: "remove_event", events: [drop], title: drop.title }] };
    }
    case "acknowledge":
      return { ok: false, error: "Nothing to change." };
    case "change_priority": {
      const t = task();
      if (!t) return gone;
      const priority = str(p.priority);
      if (priority !== "high" && priority !== "medium" && priority !== "low") return { ok: false, error: "Unknown priority." };
      if (priority === t.priority) return { ok: false, error: `It's already ${priority} priority.` };
      return { ok: true, prompt: null, specs: [{ kind: "task_update", task: t, patch: { priority } }] };
    }
    case "mark_complete": {
      const t = task();
      if (!t) return gone;
      return { ok: true, prompt: null, specs: [{ kind: "task_complete", task: t }] };
    }
  }
}
