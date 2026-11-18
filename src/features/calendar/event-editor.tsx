"use client";

import { Button, Field, Input, LifeAreaOptions, Segmented, Select, TextArea } from "@/components/ui";
import type { EventForm, RepeatChoice, RepeatEnds } from "@/lib/domain/events";
import { WEEKDAYS, type Commitment, type LifeAreaRecord, type Weekday } from "@/lib/domain/types";
import { MAX_COUNT, MAX_INTERVAL, parseRRule, weekdayOfKey, type Occurrence } from "@/lib/scheduling/recurrence";
import {
  addDaysToKey,
  dateKeyInZone,
  daysBetweenKeys,
  formatTimeInZone,
  isDateKey,
  isValidTimeZone,
  timeKeyInZone,
  zonedToUtc,
} from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { Lock, MoveVertical, TriangleAlert } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { saveEvent, type EditScope } from "./actions";

export type EditorTarget =
  | { mode: "create"; initial: EventForm }
  | { mode: "edit"; event: Commitment; occurrence: Occurrence | null; initial: EventForm };

const DAY_LETTERS: Record<Weekday, string> = { mo: "M", tu: "T", we: "W", th: "T", fr: "F", sa: "S", su: "S" };
const DAY_NAMES: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

function toTime(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function noRepeat(): EventForm["repeat"] {
  return { freq: "NONE", interval: 1, byDay: [], ends: "never", until: null, count: null };
}

/**
 * A blank event on `dateKey`. Starts at `startMin`, or the next hour when
 * the date is today, or 9 AM. `from` pre-fills an unplaced flexible activity.
 */
export function newEventForm(
  dateKey: string,
  startMin: number | undefined,
  timeZone: string,
  now: Date | null,
  from?: Commitment,
): EventForm {
  let start = startMin;
  if (start === undefined) {
    const isToday = now && dateKeyInZone(now, timeZone) === dateKey;
    start = isToday ? Math.min(23 * 60, (Math.floor(minutesOf(timeKeyInZone(now, timeZone)) / 60) + 1) * 60) : 9 * 60;
  }
  const duration = from?.estimatedMinutes && from.estimatedMinutes <= 12 * 60 ? from.estimatedMinutes : 60;
  const endMin = start + duration;
  return {
    title: from?.title ?? "",
    description: from?.notes ?? null,
    location: from?.location ?? null,
    lifeAreaId: from?.lifeAreaId ?? null,
    kind: from?.kind ?? "fixed",
    allDay: false,
    startDate: dateKey,
    startTime: toTime(start),
    endDate: endMin >= 1440 ? addDaysToKey(dateKey, 1) : dateKey,
    endTime: toTime(endMin % 1440),
    timezone: timeZone,
    repeat: noRepeat(),
  };
}

/** Form values for an existing event, shown at `occ` when one was clicked. */
export function formFromEvent(event: Commitment, occ: Occurrence | null, profileTz: string): EventForm {
  const tz = isValidTimeZone(event.timezone) ? event.timezone : profileTz;
  const start = occ?.start ?? new Date(event.startsAt!);
  const end = occ?.end ?? new Date(event.endsAt!);
  const rule = parseRRule(event.recurrenceRule);
  const allDay = event.allDay ?? false;
  const startDate = dateKeyInZone(start, tz);
  return {
    title: event.title,
    description: event.notes ?? null,
    location: event.location ?? null,
    lifeAreaId: event.lifeAreaId ?? null,
    kind: event.kind,
    allDay,
    startDate,
    startTime: allDay ? "09:00" : timeKeyInZone(start, tz),
    endDate: allDay ? addDaysToKey(dateKeyInZone(end, tz), -1) : dateKeyInZone(end, tz),
    endTime: allDay ? "10:00" : timeKeyInZone(end, tz),
    timezone: tz,
    repeat: rule
      ? {
          freq: rule.freq,
          interval: rule.interval,
          byDay: rule.byDay ?? (rule.freq === "WEEKLY" ? [weekdayOfKey(startDate)] : []),
          ends: rule.count ? "count" : rule.until ? "until" : "never",
          until: rule.until ?? null,
          count: rule.count ?? null,
        }
      : noRepeat(),
  };
}

/** Moving the start keeps the event's length. */
function withStart(f: EventForm, startDate: string, startTime: string): EventForm {
  if (!isDateKey(startDate) || !/^\d{2}:\d{2}$/.test(startTime)) return { ...f, startDate, startTime };
  if (f.allDay) {
    const span = Math.max(0, daysBetweenKeys(f.startDate, f.endDate));
    return { ...f, startDate, startTime, endDate: addDaysToKey(startDate, span) };
  }
  const oldStart = zonedToUtc(f.startDate, f.startTime, f.timezone).getTime();
  const oldEnd = zonedToUtc(f.endDate, f.endTime, f.timezone).getTime();
  const duration = Math.max(15 * 60_000, oldEnd - oldStart);
  const newEnd = new Date(zonedToUtc(startDate, startTime, f.timezone).getTime() + duration);
  return {
    ...f,
    startDate,
    startTime,
    endDate: dateKeyInZone(newEnd, f.timezone),
    endTime: timeKeyInZone(newEnd, f.timezone),
  };
}

export function EventEditor({
  target,
  areas,
  occurrences,
  onDone,
}: {
  target: EditorTarget;
  areas: LifeAreaRecord[];
  occurrences: Occurrence[];
  onDone: () => void;
}) {
  const [form, setForm] = useState<EventForm>(target.initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const isSeries = target.mode === "edit" && !!target.event.recurrenceRule && target.occurrence !== null;
  const [scope, setScope] = useState<EditScope>("series");

  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setRepeat = (patch: Partial<EventForm["repeat"]>) => setForm((f) => ({ ...f, repeat: { ...f.repeat, ...patch } }));

  // Live overlap warning against the events loaded for the visible range.
  const overlaps = useMemo(() => {
    if (form.allDay || !isDateKey(form.startDate) || !isDateKey(form.endDate)) return [];
    try {
      const s = zonedToUtc(form.startDate, form.startTime, form.timezone);
      const e = zonedToUtc(form.endDate, form.endTime, form.timezone);
      if (!(e > s)) return [];
      const selfId = target.mode === "edit" ? target.event.id : null;
      return occurrences.filter((o) => !o.allDay && o.start < e && o.end > s && o.event.id !== selfId);
    } catch {
      return [];
    }
  }, [form, occurrences, target]);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    start(async () => {
      setError(null);
      let payload = form;
      let useScope: EditScope | undefined;
      if (isSeries && target.mode === "edit" && target.occurrence) {
        useScope = scope;
        if (scope === "series") {
          // Shift the whole series by however far this occurrence moved.
          const shift = daysBetweenKeys(target.occurrence.date, form.startDate);
          const seriesStart = dateKeyInZone(new Date(target.event.startsAt!), form.timezone);
          payload = {
            ...form,
            startDate: addDaysToKey(seriesStart, shift),
            endDate: addDaysToKey(seriesStart, shift + daysBetweenKeys(form.startDate, form.endDate)),
          };
        } else {
          payload = { ...form, repeat: noRepeat() };
        }
      }
      const r = await saveEvent({
        id: target.mode === "edit" ? target.event.id : null,
        scope: useScope,
        occurrenceDate: target.mode === "edit" ? target.occurrence?.date ?? null : null,
        form: payload,
      });
      if (r.ok) onDone();
      else setError(r.error);
    });
  };

  const repeatOn = form.repeat.freq !== "NONE" && !(isSeries && scope === "single");
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year", NONE: "" }[form.repeat.freq];

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Title">
        <Input
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={200}
          placeholder="e.g. Robotics build session"
          required
          data-autofocus
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Life area">
          <Select value={form.lifeAreaId ?? ""} onChange={(e) => set("lifeAreaId", e.target.value || null)}>
            <LifeAreaOptions areas={areas} />
          </Select>
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">Type</span>
          <div className="flex gap-2">
            <KindButton active={form.kind === "fixed"} onClick={() => set("kind", "fixed")} icon={<Lock className="size-3.5" />}>
              Fixed
            </KindButton>
            <KindButton
              active={form.kind === "flexible"}
              onClick={() => set("kind", "flexible")}
              icon={<MoveVertical className="size-3.5" />}
            >
              Flexible
            </KindButton>
          </div>
        </div>
      </div>
      <p className="-mt-2 text-[12px] text-ink-3">
        {form.kind === "fixed"
          ? "Fixed: a commitment at a set time, like class or practice."
          : "Flexible: an activity you could move, like study time or a run."}
      </p>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={form.allDay}
          onChange={(e) => set("allDay", e.target.checked)}
          className="size-4 rounded border-border-strong accent-[var(--accent)]"
        />
        All day
      </label>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <Input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm((f) => withStart(f, e.target.value, f.startTime))}
            required
          />
        </Field>
        {!form.allDay ? (
          <Field label="Start time">
            <Input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm((f) => withStart(f, f.startDate, e.target.value))}
              required
            />
          </Field>
        ) : (
          <div />
        )}
        <Field label="Ends">
          <Input type="date" value={form.endDate} min={form.startDate} onChange={(e) => set("endDate", e.target.value)} required />
        </Field>
        {!form.allDay && (
          <Field label="End time">
            <Input type="time" value={form.endTime} onChange={(e) => set("endTime", e.target.value)} required />
          </Field>
        )}
      </div>

      {overlaps.length > 0 && (
        <p role="status" className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Overlaps with{" "}
            {overlaps
              .slice(0, 3)
              .map((o) => `${o.event.title} (${formatTimeInZone(o.start, form.timezone)})`)
              .join(", ")}
            {overlaps.length > 3 ? ` and ${overlaps.length - 3} more` : ""}. You can still save it.
          </span>
        </p>
      )}

      {isSeries && (
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">Apply changes to</span>
          <Segmented
            label="Apply changes to"
            value={scope}
            onChange={setScope}
            options={[
              { value: "single", label: "This event" },
              { value: "series", label: "All events" },
            ]}
          />
        </div>
      )}

      {!(isSeries && scope === "single") && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Repeat">
              <Select
                value={form.repeat.freq}
                onChange={(e) => {
                  const freq = e.target.value as RepeatChoice;
                  setRepeat({
                    freq,
                    byDay: freq === "WEEKLY" && !form.repeat.byDay.length ? [weekdayOfKey(form.startDate)] : form.repeat.byDay,
                  });
                }}
              >
                <option value="NONE">Does not repeat</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="YEARLY">Yearly</option>
              </Select>
            </Field>
            {repeatOn && (
              <Field label={`Every`} hint={`${unit}${form.repeat.interval === 1 ? "" : "s"}`}>
                <Input
                  type="number"
                  min={1}
                  max={MAX_INTERVAL}
                  value={form.repeat.interval}
                  onChange={(e) => setRepeat({ interval: Math.max(1, Math.min(MAX_INTERVAL, Number(e.target.value) || 1)) })}
                />
              </Field>
            )}
          </div>

          {repeatOn && form.repeat.freq === "WEEKLY" && (
            <div role="group" aria-label="Repeat on">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">On</span>
              <div className="flex gap-1.5">
                {WEEKDAYS.map((d) => {
                  const on = form.repeat.byDay.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      aria-label={DAY_NAMES[d]}
                      title={DAY_NAMES[d]}
                      onClick={() =>
                        setRepeat({
                          byDay: WEEKDAYS.filter((w) => (w === d ? !on : form.repeat.byDay.includes(w))),
                        })
                      }
                      className={cn(
                        "grid size-9 place-items-center rounded-lg border text-[13px] font-medium transition-colors",
                        on
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : "border-border bg-surface text-ink-3 hover:border-border-strong hover:text-ink-2",
                      )}
                    >
                      {DAY_LETTERS[d]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {repeatOn && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ends">
                <Select value={form.repeat.ends} onChange={(e) => setRepeat({ ends: e.target.value as RepeatEnds })}>
                  <option value="never">Never</option>
                  <option value="until">On a date</option>
                  <option value="count">After a number of times</option>
                </Select>
              </Field>
              {form.repeat.ends === "until" && (
                <Field label="Last date">
                  <Input
                    type="date"
                    min={form.startDate}
                    value={form.repeat.until ?? ""}
                    onChange={(e) => setRepeat({ until: e.target.value || null })}
                    required
                  />
                </Field>
              )}
              {form.repeat.ends === "count" && (
                <Field label="Times">
                  <Input
                    type="number"
                    min={1}
                    max={MAX_COUNT}
                    value={form.repeat.count ?? ""}
                    onChange={(e) => setRepeat({ count: e.target.value ? Math.max(1, Math.min(MAX_COUNT, Number(e.target.value))) : null })}
                    required
                  />
                </Field>
              )}
            </div>
          )}
        </div>
      )}

      <Field label="Location">
        <Input value={form.location ?? ""} onChange={(e) => set("location", e.target.value)} maxLength={200} placeholder="Optional" />
      </Field>
      <Field label="Description">
        <TextArea
          value={form.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
          maxLength={2000}
          placeholder="Optional notes"
        />
      </Field>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : target.mode === "create" ? "Add event" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function KindButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors",
        active
          ? "border border-accent bg-accent-soft text-accent-ink"
          : "border border-dashed border-border-strong text-ink-2 hover:text-ink",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
