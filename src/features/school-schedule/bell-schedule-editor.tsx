"use client";

import { Input, Segmented } from "@/components/ui";
import {
  DEFAULT_QUICK,
  LATE_START_QUICK,
  MAX_DAY_TYPES,
  MAX_PERIODS,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  deriveQuick,
  formatClock,
  fromMinutes,
  generatePeriods,
  matchesQuick,
  newDayTypeId,
  schoolHours,
  sortPeriods,
  toMinutes,
  type BellDayType,
  type BellPeriod,
  type BellSchedule,
  type QuickSetup,
} from "@/lib/domain/school-schedule";
import { WEEKDAYS, type Weekday } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { ChevronDown, Minus, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

/**
 * Editable bell schedule. Each day type has quick numbers (first bell,
 * classes, class length, passing time, lunch) that build exact periods,
 * plus an "Exact times" list for schedules that aren't regular.
 * Controlled: the parent owns the schedule.
 */
export function BellScheduleEditor({
  value,
  onChange,
  disabled,
}: {
  value: BellSchedule;
  onChange: (next: BellSchedule) => void;
  disabled?: boolean;
}) {
  // Quick numbers live here; periods are the source of truth.
  const [quick, setQuick] = useState<Record<string, QuickSetup>>(() =>
    Object.fromEntries(value.dayTypes.map((dt) => [dt.id, deriveQuick(dt.periods)])),
  );

  const quickFor = (dt: BellDayType) => quick[dt.id] ?? deriveQuick(dt.periods);

  function updateDayType(id: string, patch: Partial<BellDayType>) {
    onChange({ ...value, dayTypes: value.dayTypes.map((dt) => (dt.id === id ? { ...dt, ...patch } : dt)) });
  }

  function setQuickFor(dt: BellDayType, patch: Partial<QuickSetup>) {
    const next = { ...quickFor(dt), ...patch };
    setQuick((q) => ({ ...q, [dt.id]: next }));
    updateDayType(dt.id, { periods: generatePeriods(next) });
  }

  /** A weekday belongs to one day type: tapping it elsewhere moves it here. */
  function toggleDay(dt: BellDayType, day: Weekday) {
    const has = dt.days.includes(day);
    onChange({
      ...value,
      dayTypes: value.dayTypes.map((d) => {
        if (d.id === dt.id) return { ...d, days: has ? d.days.filter((x) => x !== day) : [...d.days, day] };
        return has ? d : { ...d, days: d.days.filter((x) => x !== day) };
      }),
    });
  }

  function addDayType(preset: "late" | "early" | "other") {
    const id = newDayTypeId();
    const base = value.dayTypes[0];
    const baseQuick = base ? quickFor(base) : DEFAULT_QUICK;
    const q: QuickSetup =
      preset === "late"
        ? { ...baseQuick, firstBell: LATE_START_QUICK.firstBell, classMinutes: Math.max(30, baseQuick.classMinutes - 15) }
        : preset === "early"
          ? { ...baseQuick, classMinutes: Math.max(30, baseQuick.classMinutes - 15) }
          : baseQuick;
    const label = preset === "late" ? "Late start" : preset === "early" ? "Early release" : "Other day";
    // Late start is usually one weekday (often Wednesday): suggest it, taking it
    // from the day type that has it, as long as that one keeps another day.
    const owner = value.dayTypes.find((d) => d.days.includes("we"));
    const takeWed = preset === "late" && (!owner || owner.days.length > 1);
    const day: BellDayType = { id, label, days: takeWed ? ["we"] : [], periods: generatePeriods(q) };
    setQuick((prev) => ({ ...prev, [id]: q }));
    onChange({
      ...value,
      dayTypes: [
        ...value.dayTypes.map((d) => (takeWed ? { ...d, days: d.days.filter((x) => x !== "we") } : d)),
        day,
      ],
    });
  }

  function removeDayType(id: string) {
    onChange({ ...value, dayTypes: value.dayTypes.filter((d) => d.id !== id) });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[13px] font-medium text-ink">Rotation</p>
          <p className="text-[12px] text-ink-3">
            {value.rotation === "ab" ? "Same bell times, classes alternate A and B." : "Same classes every day."}
          </p>
        </div>
        <Segmented
          label="Rotation"
          value={value.rotation}
          onChange={(rotation) => onChange({ ...value, rotation })}
          options={[
            { value: "same", label: "Same daily" },
            { value: "ab", label: "A/B days" },
          ]}
          className="sm:w-56"
        />
      </div>

      {value.dayTypes.map((dt) => (
        <DayTypeCard
          key={dt.id}
          dayType={dt}
          quick={quickFor(dt)}
          multiple={value.dayTypes.length > 1}
          disabled={disabled}
          onLabel={(label) => updateDayType(dt.id, { label })}
          onToggleDay={(d) => toggleDay(dt, d)}
          onQuick={(patch) => setQuickFor(dt, patch)}
          onPeriods={(periods) => updateDayType(dt.id, { periods })}
          onRemove={() => removeDayType(dt.id)}
          otherDays={new Set(value.dayTypes.filter((d) => d.id !== dt.id).flatMap((d) => d.days))}
        />
      ))}

      {value.dayTypes.length < MAX_DAY_TYPES && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-3">Some days run differently?</span>
          <AddChip onClick={() => addDayType("late")} disabled={disabled}>
            Late start
          </AddChip>
          <AddChip onClick={() => addDayType("early")} disabled={disabled}>
            Early release
          </AddChip>
          <AddChip onClick={() => addDayType("other")} disabled={disabled}>
            Other
          </AddChip>
        </div>
      )}
    </div>
  );
}

function AddChip({ children, onClick, disabled }: { children: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border-strong px-3 text-[12px] font-medium text-ink-2 transition-colors hover:border-accent/60 hover:text-ink disabled:opacity-50"
    >
      <Plus className="size-3.5" /> {children}
    </button>
  );
}

function DayTypeCard({
  dayType,
  quick,
  multiple,
  disabled,
  otherDays,
  onLabel,
  onToggleDay,
  onQuick,
  onPeriods,
  onRemove,
}: {
  dayType: BellDayType;
  quick: QuickSetup;
  multiple: boolean;
  disabled?: boolean;
  otherDays: Set<Weekday>;
  onLabel: (label: string) => void;
  onToggleDay: (d: Weekday) => void;
  onQuick: (patch: Partial<QuickSetup>) => void;
  onPeriods: (periods: BellPeriod[]) => void;
  onRemove: () => void;
}) {
  const custom = !matchesQuick(dayType.periods, quick);
  const [showExact, setShowExact] = useState(custom);
  const hours = schoolHours(dayType);
  const classes = dayType.periods.filter((p) => p.kind === "class").length;
  const id = dayType.id;

  return (
    <section className="rounded-xl border border-border bg-surface-2/50 p-3.5 sm:p-4" aria-label={dayType.label}>
      <div className="flex items-center gap-2">
        {multiple ? (
          <input
            value={dayType.label}
            onChange={(e) => onLabel(e.target.value)}
            disabled={disabled}
            aria-label="Schedule name"
            maxLength={40}
            className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 -ml-1.5 text-[14px] font-medium text-ink hover:border-border focus:border-accent/70 focus:outline-none"
          />
        ) : (
          <p className="flex-1 text-[14px] font-medium text-ink">{dayType.label}</p>
        )}
        {multiple && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${dayType.label}`}
            className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1 sm:flex sm:flex-wrap sm:gap-1.5" role="group" aria-label="Days">
        {WEEKDAYS.map((d) => {
          const on = dayType.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={WEEKDAY_NAMES[d]}
              onClick={() => onToggleDay(d)}
              disabled={disabled}
              title={!on && otherDays.has(d) ? "Move this day here" : undefined}
              className={cn(
                "h-9 min-w-0 rounded-full px-0 text-[12px] font-medium transition-colors sm:h-8 sm:min-w-11 sm:px-2.5",
                on
                  ? "bg-accent text-on-accent"
                  : "border border-border bg-surface text-ink-3 hover:border-border-strong hover:text-ink-2",
              )}
            >
              {WEEKDAY_SHORT[d]}
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
        <Labeled label="First bell" htmlFor={`${id}-first`}>
          <Input
            id={`${id}-first`}
            type="time"
            value={quick.firstBell}
            onChange={(e) => e.target.value && onQuick({ firstBell: e.target.value })}
            disabled={disabled}
            className="h-9"
          />
        </Labeled>
        <Labeled label="Classes per day">
          <Stepper
            value={quick.classes}
            min={1}
            max={MAX_PERIODS - 1}
            onChange={(classes) => onQuick({ classes, lunchAfter: Math.min(quick.lunchAfter, classes) })}
            disabled={disabled}
            label="classes per day"
          />
        </Labeled>
        <Labeled label="Class length" htmlFor={`${id}-len`} suffix="min">
          <NumberInput id={`${id}-len`} value={quick.classMinutes} min={10} max={240} onChange={(classMinutes) => onQuick({ classMinutes })} disabled={disabled} />
        </Labeled>
        <Labeled label="Passing time" htmlFor={`${id}-pass`} suffix="min">
          <NumberInput id={`${id}-pass`} value={quick.passingMinutes} min={0} max={30} onChange={(passingMinutes) => onQuick({ passingMinutes })} disabled={disabled} />
        </Labeled>
        <Labeled label="Lunch" htmlFor={`${id}-lunch`}>
          <select
            id={`${id}-lunch`}
            value={quick.lunchAfter}
            onChange={(e) => onQuick({ lunchAfter: Number(e.target.value) })}
            disabled={disabled}
            className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-ink focus:border-accent/70 focus:outline-none focus:ring-[3px] focus:ring-accent/15"
          >
            <option value={0}>No lunch</option>
            {Array.from({ length: quick.classes }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                After class {i + 1}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Lunch length" htmlFor={`${id}-lunchlen`} suffix="min">
          <NumberInput
            id={`${id}-lunchlen`}
            value={quick.lunchMinutes}
            min={10}
            max={120}
            onChange={(lunchMinutes) => onQuick({ lunchMinutes })}
            disabled={disabled || quick.lunchAfter === 0}
          />
        </Labeled>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-[13px] text-ink-2">
          {hours ? (
            <>
              <span className="font-medium tabular-nums text-ink">
                {formatClock(hours.start)} – {formatClock(hours.end)}
              </span>
              <span className="text-ink-3"> · {classes} {classes === 1 ? "class" : "classes"}</span>
            </>
          ) : (
            <span className="text-ink-3">No periods yet</span>
          )}
          {custom && <span className="text-ink-3"> · exact times</span>}
        </p>
        <button
          type="button"
          onClick={() => setShowExact((s) => !s)}
          aria-expanded={showExact}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent-ink hover:bg-accent-soft"
        >
          Exact times
          <ChevronDown className={cn("size-3.5 transition-transform", showExact && "rotate-180")} />
        </button>
      </div>

      {showExact && (
        <PeriodList periods={dayType.periods} onChange={onPeriods} disabled={disabled} note={custom ? "Changing the numbers above rebuilds these times." : null} />
      )}
    </section>
  );
}

function PeriodList({
  periods,
  onChange,
  disabled,
  note,
}: {
  periods: BellPeriod[];
  onChange: (p: BellPeriod[]) => void;
  disabled?: boolean;
  note: string | null;
}) {
  const sorted = sortPeriods(periods);
  const set = (i: number, patch: Partial<BellPeriod>) => onChange(sorted.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const add = () => {
    const last = sorted[sorted.length - 1];
    const start = last ? toMinutes(last.end) + 5 : toMinutes(DEFAULT_QUICK.firstBell);
    if (start + 30 > 23 * 60 + 59) return;
    const classes = sorted.filter((p) => p.kind === "class").length;
    onChange([...sorted, { label: `Period ${classes + 1}`, start: fromMinutes(start), end: fromMinutes(start + 50), kind: "class" }]);
  };

  return (
    <div className="mt-2 animate-fade-in space-y-1.5">
      {note && <p className="text-[12px] text-ink-3">{note}</p>}
      <ul className="space-y-1.5">
        {sorted.map((p, i) => (
          <li key={`${p.start}-${i}`} className="flex items-center gap-1.5">
            <input
              value={p.label}
              onChange={(e) => set(i, { label: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase();
                if (v.includes("lunch") && p.kind !== "lunch") set(i, { kind: "lunch" });
              }}
              aria-label="Period name"
              maxLength={40}
              disabled={disabled}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-accent/70 focus:outline-none",
                p.kind === "lunch" && "text-accent-ink",
              )}
            />
            <input
              type="time"
              value={p.start}
              onChange={(e) => e.target.value && set(i, { start: e.target.value })}
              aria-label={`${p.label} start`}
              disabled={disabled}
              className="h-9 w-[6.75rem] shrink-0 rounded-lg border border-border bg-surface px-2 text-[13px] tabular-nums text-ink focus:border-accent/70 focus:outline-none"
            />
            <input
              type="time"
              value={p.end}
              onChange={(e) => e.target.value && set(i, { end: e.target.value })}
              aria-label={`${p.label} end`}
              disabled={disabled}
              className="h-9 w-[6.75rem] shrink-0 rounded-lg border border-border bg-surface px-2 text-[13px] tabular-nums text-ink focus:border-accent/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onChange(sorted.filter((_, j) => j !== i))}
              disabled={disabled || sorted.length <= 1}
              aria-label={`Remove ${p.label}`}
              className="grid size-9 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-danger disabled:opacity-30"
            >
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {sorted.length < MAX_PERIODS && (
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          <Plus className="size-3.5" /> Add period
        </button>
      )}
    </div>
  );
}

function Labeled({
  label,
  htmlFor,
  suffix,
  children,
}: {
  label: string;
  htmlFor?: string;
  suffix?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1 block text-[12px] font-medium text-ink-2">
        {label}
        {suffix && <span className="font-normal text-ink-3"> ({suffix})</span>}
      </label>
      {children}
    </div>
  );
}

function NumberInput({
  id,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  // Local text so a half-typed number ("4") doesn't snap while typing.
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(String(value));
  }
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={(e) => commit(e.target.value)}
      disabled={disabled}
      className="h-9 tabular-nums"
    />
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  disabled,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={disabled || value <= min}
        aria-label={`Fewer ${label}`}
        className="grid h-full w-9 shrink-0 place-items-center rounded-l-lg text-ink-2 hover:bg-surface-2 disabled:opacity-40"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="flex-1 text-center text-sm font-medium tabular-nums text-ink" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={disabled || value >= max}
        aria-label={`More ${label}`}
        className="grid h-full w-9 shrink-0 place-items-center rounded-r-lg text-ink-2 hover:bg-surface-2 disabled:opacity-40"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
