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
  sortTasks,
  type TaskFilter,
  type TaskSort,
} from "@/lib/domain/tasks";
import type { LifeAreaRecord, Task, TaskPriority, TaskStatus } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import { Check, CircleCheck, Clock, Flag, Plus, Target, Trash2 } from "lucide-react";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { removeTask, saveTask, setTaskDone } from "./actions";
import { formatDue } from "./format";

type GoalOption = { id: string; title: string };

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: "High", medium: "Medium", low: "Low" };
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  high: "text-danger",
  medium: "text-ink-2",
  low: "text-ink-3",
};

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
  const [sort, setSort] = useState<TaskSort>("due");
  const [editing, setEditing] = useState<{ task: Task | null } | null>(null);
  const [optimistic, setOptimistic] = useOptimistic(tasks, (state, change: { id: string; status: TaskStatus }) =>
    state.map((t) => (t.id === change.id ? { ...t, status: change.status } : t)),
  );
  const [, startToggle] = useTransition();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const visible = useMemo(
    () => sortTasks(filterTasks(optimistic, filter, { todayKey, timeZone }), sort),
    [optimistic, filter, sort, todayKey, timeZone],
  );
  const openCount = optimistic.filter((t) => t.status !== "done").length;
  const overdueCount = optimistic.filter(
    (t) => t.status !== "done" && dueBucket(t, todayKey, timeZone) === "overdue",
  ).length;

  const toggle = (t: Task) =>
    startToggle(async () => {
      setToggleError(null);
      const done = t.status !== "done";
      setOptimistic({ id: t.id, status: done ? "done" : "todo" });
      const r = await setTaskDone(t.id, done);
      if (!r.ok) setToggleError(r.error);
    });

  const setF = <K extends keyof TaskFilter>(k: K, v: TaskFilter[K]) => setFilter((f) => ({ ...f, [k]: v }));
  const filtered =
    filter.area !== "all" || filter.priority !== "all" || filter.due !== "all" || filter.status !== "open";

  return (
    <div className="space-y-4">
      <QuickAdd areas={areas} disabled={disabled} onMore={() => setEditing({ task: null })} />

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
            <FilterSelect label="Due" value={filter.due} onChange={(v) => setF("due", v as TaskFilter["due"])}>
              <option value="all">Any due date</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="week">Next 7 days</option>
              <option value="none">No due date</option>
            </FilterSelect>
            <FilterSelect label="Sort" value={sort} onChange={(v) => setSort(v as TaskSort)}>
              <option value="due">Sort: due date</option>
              <option value="priority">Sort: priority</option>
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
            <ul>
              {visible.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  area={findArea(areas, t.lifeAreaId)}
                  goal={goals.find((g) => g.id === t.goalId) ?? null}
                  timeZone={timeZone}
                  todayKey={todayKey}
                  disabled={disabled}
                  onToggle={() => toggle(t)}
                  onOpen={() => setEditing({ task: t })}
                />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.task ? "Edit task" : "New task"}>
        {editing && (
          <TaskEditor
            task={editing.task}
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
  area,
  goal,
  timeZone,
  todayKey,
  disabled,
  onToggle,
  onOpen,
}: {
  task: Task;
  area: LifeAreaRecord | null;
  goal: GoalOption | null;
  timeZone: string;
  todayKey: string;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const done = t.status === "done";
  const due = formatDue(t.dueAt, timeZone, todayKey);
  const overdue = !done && dueBucket(t, todayKey, timeZone) === "overdue";
  return (
    <li className="group flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
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
          {t.status === "in_progress" && <Badge tone="accent">In progress</Badge>}
        </span>
      </button>
      <span className={cn("mt-0.5 shrink-0 text-[11px] font-medium uppercase tracking-wide", PRIORITY_STYLE[t.priority])}>
        {t.priority}
      </span>
    </li>
  );
}

/** One-line capture: type, press Enter. Details can be added later. */
function QuickAdd({ areas, disabled, onMore }: { areas: LifeAreaRecord[]; disabled: boolean; onMore: () => void }) {
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    start(async () => {
      setError(null);
      const r = await saveTask(null, { title, lifeAreaId: areaId || null, priority, dueDate: dueDate || null });
      if (r.ok) {
        setTitle("");
        setDueDate("");
      } else setError(r.error);
    });
  };

  return (
    <Card className="p-3">
      <form onSubmit={submit} className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2">
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
        <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
          <Select aria-label="Life area" value={areaId} onChange={(e) => setAreaId(e.target.value)} disabled={disabled} className="col-span-2 h-8 text-[13px] md:w-36">
            <LifeAreaOptions areas={areas} />
          </Select>
          <Select
            aria-label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            disabled={disabled}
            className="h-8 text-[13px] md:w-28"
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
          <Input
            aria-label="Due date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={disabled}
            className="h-8 text-[13px] md:w-36"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={disabled || pending || !title.trim()} className="flex-1 md:flex-none">
            {pending ? "Adding…" : "Add"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onMore} disabled={disabled}>
            Details
          </Button>
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
  areas,
  goals,
  timeZone,
  disabled,
  onDone,
}: {
  task: Task | null;
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
  const [dueDate, setDueDate] = useState(due?.date ?? "");
  const [dueTime, setDueTime] = useState(due?.time ?? "");
  const [minutes, setMinutes] = useState(task?.estimatedMinutes ? String(task.estimatedMinutes) : "");
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
        dueDate: dueDate || null,
        dueTime: dueDate && dueTime ? dueTime : null,
        estimatedMinutes: est,
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
      <Field label="Description">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Optional" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Life area">
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <LifeAreaOptions areas={areas} />
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {(["high", "medium", "low"] as const).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Due time" hint="Optional">
          <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={!dueDate} />
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
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </Select>
        </Field>
      </div>
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
