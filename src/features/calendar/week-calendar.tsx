"use client";

import { Button, SampleDataBadge, Skeleton } from "@/components/ui";
import { useNow } from "@/lib/hooks/use-now";
import { buildSampleWeek } from "@/lib/placeholder";
import {
  addDays,
  formatHour,
  isSameDay,
  minutesOfDay,
  startOfWeek,
  weekDays,
} from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import { ChevronLeft, ChevronRight, Lock, MoveVertical } from "lucide-react";
import { useMemo, useState } from "react";
import { EventBlock } from "./event-block";

type View = "day" | "week";

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 23;
const HOUR_PX = 52;
const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);

export function WeekCalendar() {
  const now = useNow();
  const [offsetDays, setOffsetDays] = useState(0);
  const [view, setView] = useState<View>("week");
  const [mobileView, setMobileView] = useState<View>("day");

  const anchor = now ? addDays(now, offsetDays) : null;

  const events = useMemo(
    () => (anchor ? buildSampleWeek(startOfWeek(anchor, 1)) : []),
    // Rebuild when the displayed week changes, not every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchor && startOfWeek(anchor, 1).getTime()],
  );

  if (!anchor || !now) {
    return <Skeleton className="h-[640px] rounded-2xl" />;
  }

  const step = (dir: 1 | -1, v: View) => setOffsetDays((d) => d + dir * (v === "week" ? 7 : 1));
  const week = weekDays(anchor, 1);

  const title = (v: View) => {
    if (v === "day") {
      return anchor.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    }
    const [a, b] = [week[0], week[6]];
    const left = a.toLocaleDateString([], { month: "short", day: "numeric" });
    const right =
      a.getMonth() === b.getMonth()
        ? String(b.getDate())
        : b.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${left} – ${right}, ${b.getFullYear()}`;
  };

  return (
    <div className="space-y-4">
      {/* Desktop and tablet use the user's chosen view; phones default to day. */}
      <div className="hidden sm:block">
        <Toolbar
          title={title(view)}
          view={view}
          onView={setView}
          onPrev={() => step(-1, view)}
          onNext={() => step(1, view)}
          onToday={() => setOffsetDays(0)}
        />
        <Grid days={view === "week" ? week : [anchor]} events={events} now={now} />
      </div>
      <div className="sm:hidden">
        <Toolbar
          title={title(mobileView)}
          view={mobileView}
          onView={setMobileView}
          onPrev={() => step(-1, mobileView)}
          onNext={() => step(1, mobileView)}
          onToday={() => setOffsetDays(0)}
        />
        {mobileView === "week" && (
          <DayStrip week={week} anchor={anchor} now={now} onPick={(d) => {
            setOffsetDays(Math.round((d.getTime() - addDays(now, 0).setHours(0, 0, 0, 0)) / 86_400_000));
            setMobileView("day");
          }} />
        )}
        <Grid days={mobileView === "week" ? week : [anchor]} events={events} now={now} compact={mobileView === "week"} />
      </div>
    </div>
  );
}

function Toolbar(props: {
  title: string;
  view: View;
  onView: (v: View) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={props.onToday}>Today</Button>
        <div className="flex">
          <button onClick={props.onPrev} aria-label="Previous" className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink">
            <ChevronLeft className="size-4" />
          </button>
          <button onClick={props.onNext} aria-label="Next" className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink">
            <ChevronRight className="size-4" />
          </button>
        </div>
        <h2 className="ml-1 text-[15px] font-semibold tracking-tight text-ink" aria-live="polite">{props.title}</h2>
      </div>

      <div className="flex items-center justify-between gap-3 md:justify-end">
        <Legend />
        <div role="tablist" aria-label="Calendar view" className="flex rounded-lg border border-border bg-surface-2 p-0.5">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={props.view === v}
              onClick={() => props.onView(v)}
              className={cn(
                "h-7 rounded-md px-3 text-[13px] font-medium capitalize transition-all",
                props.view === v ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-3">
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-4 rounded-sm border-l-[3px] border-[var(--cat-academics)] bg-[var(--cat-academics-soft)]" />
        <Lock className="size-3" /> Fixed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-4 rounded-sm border border-dashed border-[var(--cat-academics)]" />
        <MoveVertical className="size-3" /> Flexible
      </span>
      <span className="hidden lg:inline-flex"><SampleDataBadge /></span>
    </div>
  );
}

function DayStrip({ week, anchor, now, onPick }: { week: Date[]; anchor: Date; now: Date; onPick: (d: Date) => void }) {
  return (
    <div className="mb-3 grid grid-cols-7 gap-1">
      {week.map((d) => (
        <button
          key={d.toISOString()}
          onClick={() => onPick(d)}
          className={cn(
            "flex flex-col items-center rounded-lg py-1.5 text-[11px]",
            isSameDay(d, anchor) ? "bg-surface shadow-card" : "text-ink-3",
          )}
        >
          {d.toLocaleDateString([], { weekday: "narrow" })}
          <span className={cn("mt-0.5 text-sm font-medium", isSameDay(d, now) ? "text-accent" : "text-ink")}>{d.getDate()}</span>
        </button>
      ))}
    </div>
  );
}

function Grid({
  days,
  events,
  now,
  compact,
}: {
  days: Date[];
  events: ReturnType<typeof buildSampleWeek>;
  now: Date;
  compact?: boolean;
}) {
  const height = HOURS.length * HOUR_PX;
  const top = (d: Date) => ((minutesOfDay(d) - DAY_START_HOUR * 60) / 60) * HOUR_PX;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      {/* Day headers */}
      <div className="grid border-b border-border" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div />
        {days.map((d) => {
          const today = isSameDay(d, now);
          return (
            <div key={d.toISOString()} className="border-l border-border px-2 py-2.5 text-center">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {d.toLocaleDateString([], { weekday: compact ? "narrow" : "short" })}
              </p>
              <p
                className={cn(
                  "mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold",
                  today ? "bg-accent text-white" : "text-ink",
                )}
              >
                {d.getDate()}
              </p>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="max-h-[68vh] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))`, height }}>
          <div className="relative">
            {HOURS.map((h, i) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-3" style={{ top: i * HOUR_PX }}>
                {i === 0 ? "" : formatHour(h)}
              </span>
            ))}
          </div>

          {days.map((d) => {
            const dayEvents = events.filter((e) => e.startsAt && isSameDay(new Date(e.startsAt), d));
            const today = isSameDay(d, now);
            return (
              <div key={d.toISOString()} className={cn("relative border-l border-border", today && "bg-accent-soft/30")}>
                {HOURS.map((h, i) => (
                  <div key={h} className="absolute inset-x-0 border-t border-border/70" style={{ top: i * HOUR_PX }} />
                ))}
                {dayEvents.map((e) => {
                  const s = new Date(e.startsAt!);
                  const en = new Date(e.endsAt!);
                  return (
                    <EventBlock
                      key={e.id}
                      c={e}
                      style={{ top: top(s) + 1, height: Math.max(top(en) - top(s) - 2, 20) }}
                    />
                  );
                })}
                {today && minutesOfDay(now) >= DAY_START_HOUR * 60 && minutesOfDay(now) < DAY_END_HOUR * 60 && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(now) }}>
                    <span className="-ml-1 size-2 rounded-full bg-danger" />
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
