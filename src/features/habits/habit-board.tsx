"use client";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
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
import { HISTORY_WEEKS, cadenceLabel, completionRate, isScheduledOn, weekProgress } from "@/lib/domain/habits";
import { areaColors, findArea } from "@/lib/domain/life-areas";
import { WEEKDAYS, type Habit, type HabitCadence, type LifeAreaRecord, type Weekday } from "@/lib/domain/types";
import { addDaysToKey, dateKeyInZone, formatDateKey, weekKeys } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { Check, ChevronDown, Plus, Repeat, Trash2 } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { removeHabit, saveHabit, setHabitDay } from "./actions";

const DAY_NAMES: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

type Toggle = { habitId: string; date: string; done: boolean };

export function HabitBoard({
  habits,
  areas,
  todayKey,
  weekStartsOn,
  timeZone,
  disabled,
}: {
  habits: Habit[];
  areas: LifeAreaRecord[];
  todayKey: string;
  weekStartsOn: 0 | 1;
  timeZone: string;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<{ habit: Habit | null } | null>(null);
  const [optimistic, apply] = useOptimistic(habits, (state, t: Toggle) =>
    state.map((h) =>
      h.id !== t.habitId
        ? h
        : {
            ...h,
            completedOn: t.done
              ? Array.from(new Set([...h.completedOn, t.date])).sort()
              : h.completedOn.filter((d) => d !== t.date),
          },
    ),
  );
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const week = weekKeys(todayKey, weekStartsOn);

  const toggle = (habitId: string, date: string, done: boolean) =>
    start(async () => {
      setError(null);
      apply({ habitId, date, done });
      const r = await setHabitDay(habitId, date, done);
      if (!r.ok) setError(r.error);
    });

  return (
    <Card>
      <CardHeader
        title="Habits"
        description="Small routines that support the bigger goals. Missed days are fine: progress is a rate, not a streak."
        action={
          <Button size="sm" variant="secondary" onClick={() => setEditing({ habit: null })} disabled={disabled}>
            <Plus className="size-3.5" /> Habit
          </Button>
        }
      />
      <CardBody className="pt-3">
        {error && (
          <p role="alert" className="mb-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        {optimistic.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No habits yet"
            description="Try something small, like reading 20 minutes or stretching after practice."
            action={
              <Button size="sm" onClick={() => setEditing({ habit: null })} disabled={disabled}>
                <Plus className="size-3.5" /> Add a habit
              </Button>
            }
          />
        ) : (
          <>
            <div className="mb-2 hidden grid-cols-[1fr_auto_96px] items-center gap-6 px-2 text-[11px] font-medium uppercase tracking-wide text-ink-3 sm:grid">
              <span>Habit</span>
              <span className="grid grid-cols-7 gap-1.5">
                {week.map((k) => (
                  <span key={k} className="w-7 text-center">
                    {formatDateKey(k, { weekday: "narrow" })}
                  </span>
                ))}
              </span>
              <span className="text-right">This week</span>
            </div>
            <ul className="divide-y divide-border">
              {optimistic.map((h) => (
                <HabitRow
                  key={h.id}
                  habit={h}
                  area={findArea(areas, h.lifeAreaId)}
                  week={week}
                  todayKey={todayKey}
                  weekStartsOn={weekStartsOn}
                  timeZone={timeZone}
                  disabled={disabled}
                  onToggle={(date, done) => toggle(h.id, date, done)}
                  onEdit={() => setEditing({ habit: h })}
                />
              ))}
            </ul>
          </>
        )}
      </CardBody>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.habit ? "Edit habit" : "New habit"}>
        {editing && <HabitEditor habit={editing.habit} areas={areas} disabled={disabled} onDone={() => setEditing(null)} />}
      </Dialog>
    </Card>
  );
}

function HabitRow({
  habit: h,
  area,
  week,
  todayKey,
  weekStartsOn,
  timeZone,
  disabled,
  onToggle,
  onEdit,
}: {
  habit: Habit;
  area: LifeAreaRecord | null;
  week: string[];
  todayKey: string;
  weekStartsOn: 0 | 1;
  timeZone: string;
  disabled: boolean;
  onToggle: (date: string, done: boolean) => void;
  onEdit: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const color = areaColors(area).color;
  const done = new Set(h.completedOn);
  const progress = weekProgress(h, todayKey, weekStartsOn);
  const createdKey = h.createdAt ? dateKeyInZone(new Date(h.createdAt), timeZone) : undefined;
  const rate = completionRate(h, todayKey, 4, weekStartsOn, createdKey);

  return (
    <li className="px-2 py-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_96px] sm:items-center sm:gap-6">
        <div className="min-w-0">
          <button type="button" onClick={onEdit} className="block max-w-full truncate text-left text-sm font-medium text-ink hover:underline pointer-coarse:-my-2 pointer-coarse:py-2">
            {h.title}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <LifeAreaLabel area={area} />
            <span className="text-[12px] text-ink-3">{cadenceLabel(h.cadence)}</span>
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
              className="hit-area inline-flex items-center gap-0.5 text-[12px] text-ink-3 hover:text-ink"
            >
              History <ChevronDown className={cn("size-3 transition-transform", showHistory && "rotate-180")} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {week.map((k) => {
            const isDone = done.has(k);
            const future = k > todayKey;
            const planned = isScheduledOn(h.cadence, k);
            return (
              <button
                key={k}
                type="button"
                disabled={disabled || future}
                onClick={() => onToggle(k, !isDone)}
                aria-pressed={isDone}
                aria-label={`${formatDateKey(k, { weekday: "long", month: "short", day: "numeric" })}: ${isDone ? "done" : "not done"}${planned ? "" : " (not planned)"}`}
                className={cn(
                  "grid size-7 place-items-center rounded-md border transition-[background-color,border-color,transform] duration-150 active:scale-90 disabled:cursor-default pointer-coarse:size-9 pointer-coarse:rounded-lg",
                  !isDone && !future && "hover:border-ink-3",
                  !planned && !isDone && "border-dashed opacity-60",
                  future && "opacity-40",
                  k === todayKey && !isDone && "ring-1 ring-accent/50",
                )}
                style={isDone ? { background: color, borderColor: color } : { borderColor: "var(--border-strong)" }}
              >
                {isDone && <Check className="size-3.5 text-on-accent" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
        <div className="flex items-baseline justify-between sm:block sm:text-right">
          <p className="text-[13px] tabular-nums text-ink-2">
            {progress.done} of {progress.target}
          </p>
          {rate !== null && <p className="text-[11px] tabular-nums text-ink-3">{rate}% last 4 weeks</p>}
        </div>
      </div>
      {showHistory && (
        <HistoryGrid
          habit={h}
          color={color}
          todayKey={todayKey}
          weekStartsOn={weekStartsOn}
          createdKey={createdKey}
          disabled={disabled}
          onToggle={onToggle}
        />
      )}
    </li>
  );
}

/** Last 12 weeks + this week. Columns are weeks, rows are weekdays. */
function HistoryGrid({
  habit,
  color,
  todayKey,
  weekStartsOn,
  createdKey,
  disabled,
  onToggle,
}: {
  habit: Habit;
  color: string;
  todayKey: string;
  weekStartsOn: 0 | 1;
  createdKey?: string;
  disabled: boolean;
  onToggle: (date: string, done: boolean) => void;
}) {
  const firstWeek = addDaysToKey(weekKeys(todayKey, weekStartsOn)[0], -7 * HISTORY_WEEKS);
  const weeks = Array.from({ length: HISTORY_WEEKS + 1 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDaysToKey(firstWeek, 7 * w + d)),
  );
  const done = new Set(habit.completedOn);
  const rate = completionRate(habit, todayKey, HISTORY_WEEKS, weekStartsOn, createdKey);
  const total = habit.completedOn.length;

  return (
    <div className="mt-3 rounded-xl bg-surface-2/60 p-3">
      <div className="flex gap-3 overflow-x-auto pb-1">
        <div className="grid shrink-0 grid-rows-7 gap-1 pt-4 text-[9px] leading-[14px] text-ink-3">
          {weeks[0].map((k) => (
            <span key={k}>{formatDateKey(k, { weekday: "narrow" })}</span>
          ))}
        </div>
        {weeks.map((days) => (
          <div key={days[0]} className="shrink-0">
            <p className="mb-1 h-3 text-[9px] text-ink-3">
              {Number(days[0].slice(8)) <= 7 ? formatDateKey(days[0], { month: "short" }) : ""}
            </p>
            <div className="grid grid-rows-7 gap-1">
              {days.map((k) => {
                const isDone = done.has(k);
                const future = k > todayKey;
                const before = createdKey ? k < createdKey : false;
                const planned = isScheduledOn(habit.cadence, k);
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled || future}
                    onClick={() => onToggle(k, !isDone)}
                    aria-label={`${formatDateKey(k, { weekday: "short", month: "short", day: "numeric" })}: ${isDone ? "done" : "not done"}`}
                    className={cn(
                      "size-3.5 rounded-[3px] border disabled:cursor-default",
                      future && "invisible",
                      !isDone && (before || !planned ? "border-transparent bg-border/50" : "border-border-strong bg-surface"),
                    )}
                    style={isDone ? { background: color, borderColor: color } : undefined}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        {total} check-in{total === 1 ? "" : "s"} in the last {HISTORY_WEEKS} weeks
        {rate !== null && <> · {rate}% of planned days</>}. Tap a past day to fix a missed check-in.
      </p>
    </div>
  );
}

function HabitEditor({
  habit,
  areas,
  disabled,
  onDone,
}: {
  habit: Habit | null;
  areas: LifeAreaRecord[];
  disabled: boolean;
  onDone: () => void;
}) {
  const initial = habit?.cadence ?? { type: "daily" };
  const [title, setTitle] = useState(habit?.title ?? "");
  const [description, setDescription] = useState(habit?.description ?? "");
  const [areaId, setAreaId] = useState(habit?.lifeAreaId ?? "");
  const [type, setType] = useState<HabitCadence["type"]>(initial.type);
  const [times, setTimes] = useState(initial.type === "weekly" ? initial.timesPerWeek : 3);
  const [days, setDays] = useState<Weekday[]>(initial.type === "specific_days" ? initial.days : ["mo", "we", "fr"]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const cadence: HabitCadence =
    type === "daily" ? { type } : type === "weekly" ? { type, timesPerWeek: times } : { type, days };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await saveHabit(habit?.id ?? null, { title, description, lifeAreaId: areaId || null, cadence });
      if (r.ok) onDone();
      else setError(r.error);
    });
  };

  const remove = () =>
    start(async () => {
      const r = await removeHabit(habit!.id);
      if (r.ok) onDone();
      else setError(r.error);
    });

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Habit">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="e.g. Read 20 minutes"
          required
          data-autofocus
        />
      </Field>
      <Field label="Life area">
        <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
          <LifeAreaOptions areas={areas} />
        </Select>
      </Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-ink">How often</span>
        <Segmented
          label="How often"
          value={type}
          onChange={setType}
          options={[
            { value: "daily", label: "Every day" },
            { value: "specific_days", label: "Certain days" },
            { value: "weekly", label: "Times a week" },
          ]}
        />
      </div>
      {type === "specific_days" && (
        <div role="group" aria-label="Days">
          <div className="flex gap-1.5">
            {WEEKDAYS.map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[d]}
                  title={DAY_NAMES[d]}
                  onClick={() => setDays(WEEKDAYS.filter((w) => (w === d ? !on : days.includes(w))))}
                  className={cn(
                    "grid size-9 place-items-center rounded-lg border text-[13px] font-medium transition-colors",
                    on
                      ? "border-accent bg-accent-soft text-accent-ink"
                      : "border-border bg-surface text-ink-3 hover:border-border-strong hover:text-ink-2",
                  )}
                >
                  {DAY_NAMES[d][0]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {type === "weekly" && (
        <Field label="Times per week" hint="Any days you like.">
          <Select value={times} onChange={(e) => setTimes(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n}× a week
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Notes">
        <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} placeholder="Optional: why it matters, or the cue" />
      </Field>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto w-full text-[13px] text-danger sm:w-auto">
            {error}
          </p>
        )}
        {habit &&
          (confirmDelete ? (
            <span className="mr-auto flex items-center gap-2">
              <span className="text-[13px] text-ink-2">Delete habit and its history?</span>
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
          {pending ? "Saving…" : habit ? "Save" : "Add habit"}
        </Button>
      </div>
    </form>
  );
}
