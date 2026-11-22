"use client";

import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  LifeAreaLabel,
  LifeAreaOptions,
  Segmented,
  Select,
  TextArea,
} from "@/components/ui";
import { findArea } from "@/lib/domain/life-areas";
import {
  DEFAULT_TASK_FILTER,
  TASK_MAX_MINUTES,
  TASK_TITLE_MAX,
  dueBucket,
  dueParts,
  filterTasks,
  nextRepeatDue,
  repeatLabel,
  sortTasks,
  type TaskFilter,
  type TaskSort,
} from "@/lib/domain/tasks";
import type { LifeAreaRecord, Task, TaskPriority, TaskRepeat, TaskStatus } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import { CalendarPlus, Check, CircleCheck, Clock, Flag, ListTree, Plus, Repeat, Target, Trash2, X } from "lucide-react";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { removeTask, saveTask, setTaskDone } from "./actions";
import { formatDue } from "./format";
import { PRIORITY_LABEL, PriorityDot, PriorityPicker, PriorityTag } from "./priority";
import { StepsPanel } from "./steps-panel";

type GoalOption = { id: string; title: string };


export function TaskBoard({
  tasks,
  goals,
  areas,
  timeZone,
  todayKey,
  disabled,
}: {
  tasks: Task[];
  goals: GoalOption[];
  areas: LifeAreaRecord[];
  timeZone: string;
  todayKey: string;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState<TaskFilter>(DEFAULT_TASK_FILTER);
  const [sort, setSort] = useState<TaskSort>("priority");
  const [editing, setEditing] = useState<{ task: Task | null } | null>(null);
  const [optimistic, setOptimistic] = useOptimistic(
    tasks,
    (state, change: { id: string; status: TaskStatus; dueAt?: string | null }) =>
      state.map((t) =>
        t.id === change.id ? { ...t, status: change.status, ...(change.dueAt !== undefined ? { dueAt: change.dueAt } : {}) } : t,
      ),
  );
  const [, startToggle] = useTransition();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const visible = useMemo(
    () => sortTasks(filterTasks(optimistic, filter, { todayKey, timeZone }), sort),
    [optimistic, filter, sort, todayKey, timeZone],
  );
  // Steps sit right under their task (when both are shown), in due order.
  const stepsOf = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of optimistic) {
      if (!t.parentTaskId) continue;
      map.set(t.parentTaskId, [...(map.get(t.parentTaskId) ?? []), t]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.title.localeCompare(b.title));
    return map;
  }, [optimistic]);
  const rows = useMemo(() => {
    const shown = new Set(visible.map((t) => t.id));
    const out: { task: Task; step: boolean }[] = [];
    for (const t of visible) {
      if (t.parentTaskId && shown.has(t.parentTaskId)) continue; // listed under its task
      out.push({ task: t, step: !!t.parentTaskId });
      for (const s of stepsOf.get(t.id) ?? []) if (shown.has(s.id)) out.push({ task: s, step: true });
    }
    return out;
  }, [visible, stepsOf]);
  // Priority view: the list is grouped High / Medium / Low. Steps stay with their task.
  const grouped = sort === "priority" && filter.priority === "all";
  const groups = useMemo(() => {
    const out: { priority: TaskPriority; rows: typeof rows; count: number }[] = [];
    for (const row of rows) {
      const nested = row.step && rows.some((r) => r.task.id === row.task.parentTaskId);
      const last = out[out.length - 1];
      if (nested && last) last.rows.push(row);
      else if (last && last.priority === row.task.priority) {
        last.rows.push(row);
        last.count++;
      } else out.push({ priority: row.task.priority, rows: [row], count: 1 });
    }
    return out;
  }, [rows]);
  const parentTitle = (t: Task) => (t.parentTaskId ? optimistic.find((p) => p.id === t.parentTaskId)?.title ?? null : null);
  const openCount = optimistic.filter((t) => t.status !== "done").length;
  const overdueCount = optimistic.filter(
    (t) => t.status !== "done" && dueBucket(t, todayKey, timeZone) === "overdue",
  ).length;

  const toggle = (t: Task) =>
    startToggle(async () => {
      setToggleError(null);
      const done = t.status !== "done";
      // A repeating task stays open. The check moves it to the next day.
      if (done && t.repeat) setOptimistic({ id: t.id, status: "todo", dueAt: nextRepeatDue(t.repeat, todayKey, t.dueAt, timeZone) });
      else setOptimistic({ id: t.id, status: done ? "done" : "todo" });
      const r = await setTaskDone(t.id, done);
      if (!r.ok) setToggleError(r.error);
    });

  const setF = <K extends keyof TaskFilter>(k: K, v: TaskFilter[K]) => setFilter((f) => ({ ...f, [k]: v }));
  const filtered =
    filter.area !== "all" || filter.priority !== "all" || filter.due !== "all" || filter.status !== "open";

  return (
    <div className="space-y-4">
      <QuickAdd areas={areas} todayKey={todayKey} disabled={disabled} onMore={() => setEditing({ task: null })} />

      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Segmented
              label="Status"
              value={filter.status}
              onChange={(v) => setF("status", v)}
              options={[
                { value: "open", label: `Open${openCount ? ` ${openCount}` : ""}` },
                { value: "done", label: "Done" },
                { value: "all", label: "All" },
              ]}
            />
            {overdueCount > 0 && filter.status !== "done" && (
              <button
                type="button"
                onClick={() => setF("due", filter.due === "overdue" ? "all" : "overdue")}
                className="text-[12px] font-medium text-danger hover:underline"
              >
                {overdueCount} overdue
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <FilterSelect label="Life area" value={filter.area} onChange={(v) => setF("area", v)}>
              <option value="all">All areas</option>
              <option value="none">No area</option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Priority" value={filter.priority} onChange={(v) => setF("priority", v as TaskFilter["priority"])}>
              <option value="all">Any priority</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </FilterSelect>
            <FilterSelect label="Sort" value={sort} onChange={(v) => setSort(v as TaskSort)}>
              <option value="priority">Sort: priority</option>
              <option value="due">Sort: due date</option>
              <option value="duration">Sort: shortest first</option>
              <option value="created">Sort: newest</option>
            </FilterSelect>
          </div>
        </div>

        {toggleError && (
          <p role="alert" className="px-4 pt-3 text-[13px] text-danger">
            {toggleError}
          </p>
        )}

        <div className="p-2">
          {visible.length === 0 ? (
            tasks.length === 0 ? (
              <EmptyState
                icon={CircleCheck}
                title="No tasks yet"
                description="Add homework, applications or errands above. Tasks stay off your calendar until you decide."
              />
            ) : (
              <EmptyState
                title={filter.status === "open" && !filtered ? "All done" : "Nothing matches"}
                description={
                  filtered ? (
                    <button type="button" className="text-accent-ink hover:underline" onClick={() => setFilter(DEFAULT_TASK_FILTER)}>
                      Clear filters
                    </button>
                  ) : (
                    "Every open task is checked off."
                  )
                }
              />
            )
          ) : (
            (grouped ? groups : [{ priority: null, rows, count: rows.length }]).map((g, i) => (
              <section key={g.priority ?? "all"} className={cn(i > 0 && "mt-2 border-t border-border pt-2")}>
                {g.priority && (
                  <h3 className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                    <PriorityDot priority={g.priority} />
                    {PRIORITY_LABEL[g.priority]} priority
                    <span className="font-medium tabular-nums">{g.count}</span>
                  </h3>
                )}
                <ul>
                  {g.rows.map(({ task: t, step }) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      step={step}
                      steps={stepsOf.get(t.id) ?? []}
                      parentTitle={step && !rows.some((r) => r.task.id === t.parentTaskId) ? parentTitle(t) : null}
                      area={findArea(areas, t.lifeAreaId)}
                      goal={goals.find((x) => x.id === t.goalId) ?? null}
                      timeZone={timeZone}
                      todayKey={todayKey}
                      disabled={disabled}
                      showPriority={!grouped}
                      onToggle={() => toggle(t)}
                      onOpen={() => setEditing({ task: t })}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </Card>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.task ? "Edit task" : "New task"}>
        {editing && (
          <TaskEditor
            task={editing.task}
            steps={editing.task ? stepsOf.get(editing.task.id) ?? [] : []}
            todayKey={todayKey}
            areas={areas}
            goals={goals}
            timeZone={timeZone}
            disabled={disabled}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

function RepeatOptions() {
  return (
    <>
      <option value="">Does not repeat</option>
      <option value="daily">Every day</option>
      <option value="weekdays">Weekdays</option>
      <option value="weekly">Every week</option>
      <option value="monthly">Every month</option>
    </>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-[13px] sm:w-auto">
      {children}
    </Select>
  );
}

function TaskRow({
  task: t,
  step,
  steps,
  parentTitle,
  area,
  goal,
  timeZone,
  todayKey,
  disabled,
  showPriority,
  onToggle,
  onOpen,
}: {
  task: Task;
  /** A step of a bigger task: indented under it. */
  step: boolean;
  /** This task's own steps. */
  steps: Task[];
  /** Shown when the step appears without its task (filtered out). */
  parentTitle: string | null;
  area: LifeAreaRecord | null;
  goal: GoalOption | null;
  timeZone: string;
  todayKey: string;
  disabled: boolean;
  /** Off when the list is already grouped by priority. */
  showPriority: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const done = t.status === "done";
  const due = formatDue(t.dueAt, timeZone, todayKey);
  const overdue = !done && dueBucket(t, todayKey, timeZone) === "overdue";
  return (
    <li className={cn("group flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2", step && !parentTitle && "ml-7")}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={
          done ? `Mark "${t.title}" not done` : t.repeat ? `Done for now, "${t.title}" comes back next time` : `Mark "${t.title}" done`
        }
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          "hit-area mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-md border-[1.5px] transition-[background-color,border-color,transform] duration-150 active:scale-90 pointer-coarse:size-[22px] pointer-coarse:mt-0",
          done ? "border-transparent bg-ink text-bg" : "border-border-strong hover:border-accent",
          t.status === "in_progress" && "border-accent bg-accent-soft",
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className={cn("block text-sm text-ink", done && "text-ink-3 line-through decoration-ink-3/40")}>{t.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <LifeAreaLabel area={area} />
          {t.repeat && (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
              <Repeat className="size-3" /> {repeatLabel(t.repeat)}
            </span>
          )}
          {due && (
            <span className={cn("inline-flex items-center gap-1 text-[12px]", overdue ? "font-medium text-danger" : "text-ink-3")}>
              <Flag className="size-3" /> {due}
            </span>
          )}
          {t.estimatedMinutes ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
              <Clock className="size-3" /> {formatDuration(t.estimatedMinutes)}
            </span>
          ) : null}
          {goal && (
            <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-ink-3">
              <Target className="size-3 shrink-0" /> <span className="truncate">{goal.title}</span>
            </span>
          )}
          {steps.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
              <ListTree className="size-3" /> {steps.filter((x) => x.status === "done").length} of {steps.length} steps
            </span>
          )}
          {parentTitle && <span className="truncate text-[12px] text-ink-3">Step of {parentTitle}</span>}
          {t.status === "in_progress" && <Badge tone="accent">In progress</Badge>}
        </span>
      </button>
      {showPriority && <PriorityTag priority={t.priority} className={cn("mt-0.5 shrink-0", done && "opacity-60")} />}
    </li>
  );
}

/** One-line capture: type, pick a priority, press Enter. A due date is optional. */
function QuickAdd({ areas, todayKey, disabled, onMore }: { areas: LifeAreaRecord[]; todayKey: string; disabled: boolean; onMore: () => void }) {
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [repeat, setRepeat] = useState<TaskRepeat | "">("");
  const [showDue, setShowDue] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    start(async () => {
      setError(null);
      const r = await saveTask(null, {
        title,
        lifeAreaId: areaId || null,
        priority,
        repeat: repeat || null,
        dueDate: showDue && dueDate ? dueDate : repeat ? todayKey : null,
      });
      if (r.ok) {
        setTitle("");
        setDueDate("");
        setShowDue(false);
        setRepeat("");
      } else setError(r.error);
    });
  };

  return (
    <Card className="p-3">
      <form onSubmit={submit} className="space-y-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Plus className="ml-1 size-4 shrink-0 text-ink-3" />
          <Input
            aria-label="New task"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task and press Enter"
            maxLength={TASK_TITLE_MAX}
            disabled={disabled || pending}
            className="border-transparent bg-transparent px-1 hover:border-transparent focus:border-transparent focus:ring-0"
          />
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <PriorityPicker value={priority} onChange={setPriority} disabled={disabled} size="sm" className="md:w-64" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Select aria-label="Life area" value={areaId} onChange={(e) => setAreaId(e.target.value)} disabled={disabled} className="h-8 min-w-0 flex-1 text-[13px] md:w-36 md:flex-none">
              <LifeAreaOptions areas={areas} />
            </Select>
            {showDue ? (
              <span className="flex items-center gap-1">
                <Input
                  aria-label="Due date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={disabled}
                  data-autofocus
                  className="h-8 w-36 text-[13px]"
                />
                <button
                  type="button"
                  aria-label="Remove due date"
                  onClick={() => {
                    setShowDue(false);
                    setDueDate("");
                  }}
                  className="hit-area grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowDue(true)} disabled={disabled} className="shrink-0 text-ink-3">
                <CalendarPlus className="size-3.5" /> Due date
              </Button>
            )}
            <Select
              aria-label="Repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as TaskRepeat | "")}
              disabled={disabled}
              className="h-8 min-w-[8.5rem] flex-1 basis-32 text-[13px] md:w-36 md:flex-none"
            >
              <RepeatOptions />
            </Select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled || pending || !title.trim()} className="flex-1 md:flex-none">
              {pending ? "Adding…" : "Add"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onMore} disabled={disabled}>
              Details
            </Button>
          </div>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 px-1 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}

function TaskEditor({
  task,
  steps,
  todayKey,
  areas,
  goals,
  timeZone,
  disabled,
  onDone,
}: {
  task: Task | null;
  steps: Task[];
  todayKey: string;
  areas: LifeAreaRecord[];
  goals: GoalOption[];
  timeZone: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const due = dueParts(task?.dueAt ?? null, timeZone);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [areaId, setAreaId] = useState(task?.lifeAreaId ?? "");
  const [goalId, setGoalId] = useState(task?.goalId ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "medium");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [showDue, setShowDue] = useState(!!due);
  const [dueDate, setDueDate] = useState(due?.date ?? "");
  const [dueTime, setDueTime] = useState(due?.time ?? "");
  const [minutes, setMinutes] = useState(task?.estimatedMinutes ? String(task.estimatedMinutes) : "");
  const [repeat, setRepeat] = useState<TaskRepeat | "">(task?.repeat ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const est = minutes.trim() ? Number(minutes) : null;
    if (est !== null && !(Number.isInteger(est) && est > 0)) {
      setError("Estimated time must be a whole number of minutes.");
      return;
    }
    start(async () => {
      setError(null);
      const r = await saveTask(task?.id ?? null, {
        title,
        description,
        lifeAreaId: areaId || null,
        goalId: goalId || null,
        priority,
        status,
        dueDate: showDue && dueDate ? dueDate : !task?.parentTaskId && repeat && status !== "done" ? todayKey : null,
        dueTime: showDue && dueDate && dueTime ? dueTime : null,
        estimatedMinutes: est,
        repeat: task?.parentTaskId ? null : repeat || null,
      });
      if (r.ok) onDone();
      else setError(r.error);
    });
  };

  const remove = () =>
    start(async () => {
      setError(null);
      const r = await removeTask(task!.id);
      if (r.ok) onDone();
      else setError(r.error);
    });

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TASK_TITLE_MAX} required data-autofocus />
      </Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-ink">Priority</span>
        <PriorityPicker value={priority} onChange={setPriority} />
      </div>
      <Field label="Description">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Optional" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Life area">
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <LifeAreaOptions areas={areas} />
          </Select>
        </Field>
        <Field label="Estimated minutes">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={TASK_MAX_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="e.g. 45"
          />
        </Field>
        {task && (
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </Select>
          </Field>
        )}
      </div>
      {showDue ? (
        <div className="rounded-xl border border-border bg-surface-2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink-2">Due date</span>
            <button
              type="button"
              onClick={() => {
                setShowDue(false);
                setDueDate("");
                setDueTime("");
              }}
              className="text-[12px] text-ink-3 hover:text-ink-2 hover:underline"
            >
              Remove
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input aria-label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <Input aria-label="Due time (optional)" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={!dueDate} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowDue(true)}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-accent-ink"
        >
          <CalendarPlus className="size-3.5" /> Add a due date
          <span className="font-normal">(optional)</span>
        </button>
      )}
      {!task?.parentTaskId && (
        <Field label="Repeat" hint="Checking it off brings this task back next time. Set the status to Done when you're finished with it.">
          <Select value={repeat} onChange={(e) => setRepeat(e.target.value as TaskRepeat | "")}>
            <RepeatOptions />
          </Select>
        </Field>
      )}
      {goals.length > 0 && (
        <Field label="Goal" hint="Optional: what this task moves forward.">
          <Select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">No goal</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {task && task.status !== "done" && (
        <StepsPanel task={task} steps={steps} timeZone={timeZone} todayKey={todayKey} disabled={disabled} onSaved={onDone} />
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto w-full text-[13px] text-danger sm:w-auto">
            {error}
          </p>
        )}
        {task &&
          (confirmDelete ? (
            <span className="mr-auto flex items-center gap-2">
              <span className="text-[13px] text-ink-2">Delete this task?</span>
              <Button type="button" size="sm" className="bg-danger hover:bg-danger/90" onClick={remove} disabled={pending}>
                Delete
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={pending}>
                Keep
              </Button>
            </span>
          ) : (
            <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => setConfirmDelete(true)} disabled={disabled}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          ))}
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || disabled}>
          {pending ? "Saving…" : task ? "Save" : "Add task"}
        </Button>
      </div>
    </form>
  );
}
