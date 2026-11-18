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
  Progress,
  Segmented,
  Select,
  TextArea,
} from "@/components/ui";
import { areaColors, findArea } from "@/lib/domain/life-areas";
import type { Goal, GoalStatus, LifeAreaRecord } from "@/lib/domain/types";
import { daysBetweenKeys, formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { Flag, PenLine, Plus, Target, Trash2 } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { removeGoalById, saveGoalForm, updateGoalProgress } from "./actions";

const STATUS_LABEL: Record<GoalStatus, string> = { active: "Active", paused: "Paused", completed: "Completed" };

function targetText(targetDate: string, todayKey: string, status: GoalStatus): { text: string; late: boolean } {
  const date = formatDateKey(targetDate, { month: "short", day: "numeric", year: "numeric" });
  if (status === "completed") return { text: date, late: false };
  const days = daysBetweenKeys(todayKey, targetDate);
  if (days < 0) return { text: `${date} · passed`, late: true };
  if (days === 0) return { text: `${date} · today`, late: false };
  if (days <= 60) return { text: `${date} · ${days} day${days === 1 ? "" : "s"} left`, late: false };
  return { text: date, late: false };
}

export function GoalBoard({
  goals,
  areas,
  todayKey,
  disabled,
}: {
  goals: Goal[];
  areas: LifeAreaRecord[];
  todayKey: string;
  disabled: boolean;
}) {
  const [show, setShow] = useState<"active" | "completed" | "all">("active");
  const [editing, setEditing] = useState<{ goal: Goal | null } | null>(null);
  const [optimistic, setProgress] = useOptimistic(goals, (state, p: { id: string; progress: number }) =>
    state.map((g) =>
      g.id === p.id ? { ...g, progress: p.progress, status: p.progress === 100 ? "completed" : g.status } : g,
    ),
  );
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const visible = optimistic.filter((g) =>
    show === "all" ? true : show === "completed" ? g.status === "completed" : g.status !== "completed",
  );

  const commitProgress = (id: string, progress: number) =>
    start(async () => {
      setError(null);
      setProgress({ id, progress });
      const r = await updateGoalProgress(id, progress);
      if (!r.ok) setError(r.error);
    });

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Goals</h2>
          <p className="text-[13px] text-ink-3">Longer arcs. Update progress yourself as you go.</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            label="Show goals"
            value={show}
            onChange={setShow}
            options={[
              { value: "active", label: "Current" },
              { value: "completed", label: "Completed" },
              { value: "all", label: "All" },
            ]}
          />
          <Button size="sm" onClick={() => setEditing({ goal: null })} disabled={disabled}>
            <Plus className="size-3.5" /> Goal
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon={Target}
            title={goals.length === 0 ? "No goals yet" : show === "completed" ? "No completed goals yet" : "No current goals"}
            description={
              goals.length === 0
                ? "Set something you're working toward, like a 5K time or an application deadline."
                : undefined
            }
            action={
              goals.length === 0 ? (
                <Button size="sm" onClick={() => setEditing({ goal: null })} disabled={disabled}>
                  <Plus className="size-3.5" /> Add a goal
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              area={findArea(areas, g.lifeAreaId)}
              todayKey={todayKey}
              disabled={disabled}
              onEdit={() => setEditing({ goal: g })}
              onProgress={(p) => commitProgress(g.id, p)}
            />
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.goal ? "Edit goal" : "New goal"}>
        {editing && <GoalEditor goal={editing.goal} areas={areas} disabled={disabled} onDone={() => setEditing(null)} />}
      </Dialog>
    </section>
  );
}

function GoalCard({
  goal: g,
  area,
  todayKey,
  disabled,
  onEdit,
  onProgress,
}: {
  goal: Goal;
  area: LifeAreaRecord | null;
  todayKey: string;
  disabled: boolean;
  onEdit: () => void;
  onProgress: (p: number) => void;
}) {
  const saved = g.progress ?? 0;
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? saved;
  const target = g.targetDate ? targetText(g.targetDate, todayKey, g.status) : null;
  const commit = () => {
    if (draft !== null && draft !== saved) onProgress(draft);
    setDraft(null);
  };

  return (
    <Card className={cn("flex flex-col p-5", g.status === "paused" && "opacity-75")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{g.title}</h3>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${g.title}`}
          className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <PenLine className="size-4" />
        </button>
      </div>
      {g.description && <p className="mt-1 line-clamp-3 text-[13px] text-ink-3">{g.description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <LifeAreaLabel area={area} />
        {target && (
          <span className={cn("flex items-center gap-1", target.late && "text-danger")}>
            <Flag className="size-3" /> {target.text}
          </span>
        )}
        {g.status !== "active" && <Badge>{STATUS_LABEL[g.status]}</Badge>}
      </div>

      <div className="mt-auto pt-4">
        <div className="flex items-center gap-3">
          <Progress value={value} color={areaColors(area).color} />
          <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-ink-2">{value}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={value}
          disabled={disabled}
          aria-label={`Progress for ${g.title}`}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="mt-2 w-full accent-[var(--accent)] disabled:opacity-50"
        />
      </div>
    </Card>
  );
}

function GoalEditor({
  goal,
  areas,
  disabled,
  onDone,
}: {
  goal: Goal | null;
  areas: LifeAreaRecord[];
  disabled: boolean;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [areaId, setAreaId] = useState(goal?.lifeAreaId ?? "");
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? "active");
  const [progress, setProgress] = useState(goal?.progress ?? 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await saveGoalForm(goal?.id ?? null, {
        title,
        description,
        lifeAreaId: areaId || null,
        targetDate: targetDate || null,
        status,
        progress,
        horizon: goal?.horizon ?? null,
      });
      if (r.ok) onDone();
      else setError(r.error);
    });
  };

  const remove = () =>
    start(async () => {
      const r = await removeGoalById(goal!.id);
      if (r.ok) onDone();
      else setError(r.error);
    });

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Goal">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="e.g. Run a sub-20 5K"
          required
          data-autofocus
        />
      </Field>
      <Field label="Description">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="What does done look like?" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Life area">
          <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <LifeAreaOptions areas={areas} />
          </Select>
        </Field>
        <Field label="Target date" hint="Optional">
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as GoalStatus)}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
          </Select>
        </Field>
        <Field label={`Progress: ${progress}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={progress}
            onChange={(e) => setProgress(Number(e.target.value))}
            className="h-10 w-full accent-[var(--accent)]"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto w-full text-[13px] text-danger sm:w-auto">
            {error}
          </p>
        )}
        {goal &&
          (confirmDelete ? (
            <span className="mr-auto flex items-center gap-2">
              <span className="text-[13px] text-ink-2">Delete this goal?</span>
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
          {pending ? "Saving…" : goal ? "Save" : "Add goal"}
        </Button>
      </div>
    </form>
  );
}
