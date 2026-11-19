"use client";

import type { LifeAreaRecord } from "@/lib/domain/types";
import { allDayOn, layoutDay } from "@/lib/scheduling/layout";
import type { Occurrence } from "@/lib/scheduling/recurrence";
import { formatDateKey, formatMinutes, minutesInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { useEffect, useMemo, useRef } from "react";
import { EventBlock, EventChip } from "./event-block";

const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const SNAP_MIN = 30;

/** Day and week views: an all-day row above a 24-hour time grid. */
export function TimeGrid({
  dayKeys,
  occurrences,
  conflicts,
  areas,
  timeZone,
  todayKey,
  now,
  compact,
  onSelect,
  onCreate,
  onOpenDay,
}: {
  dayKeys: string[];
  occurrences: Occurrence[];
  conflicts: Map<string, string[]>;
  areas: LifeAreaRecord[];
  timeZone: string;
  todayKey: string;
  now: Date | null;
  compact: boolean;
  onSelect: (o: Occurrence) => void;
  onCreate: (dateKey: string, startMin?: number) => void;
  onOpenDay: (dateKey: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = `52px repeat(${dayKeys.length}, minmax(0, 1fr))`;

  const placed = useMemo(
    () => dayKeys.map((k) => layoutDay(occurrences, k, timeZone)),
    [dayKeys, occurrences, timeZone],
  );
  const allDay = useMemo(
    () => dayKeys.map((k) => allDayOn(occurrences, k, timeZone)),
    [dayKeys, occurrences, timeZone],
  );
  const hasAllDay = allDay.some((list) => list.length > 0);

  // Start scrolled to the first event of the range, or 7 AM.
  const firstMin = Math.min(7 * 60, ...placed.flat().map((p) => p.startMin));
  const scrollKey = dayKeys[0];
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (firstMin / 60) * HOUR_PX - 12);
    // Only when the visible range changes, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  const nowMin = now ? minutesInZone(now, timeZone) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      {/* Day headers */}
      <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }}>
        <div />
        {dayKeys.map((k) => {
          const today = k === todayKey;
          return (
            <button
              type="button"
              key={k}
              onClick={() => onOpenDay(k)}
              disabled={dayKeys.length === 1}
              className="border-l border-border px-1 py-2.5 text-center disabled:cursor-default enabled:hover:bg-surface-2"
              aria-label={formatDateKey(k, { weekday: "long", month: "long", day: "numeric" })}
            >
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {compact ? (
                  <>
                    <span className="sm:hidden">{formatDateKey(k, { weekday: "narrow" })}</span>
                    <span className="hidden sm:inline">{formatDateKey(k, { weekday: "short" })}</span>
                  </>
                ) : (
                  formatDateKey(k, { weekday: "short" })
                )}
              </span>
              <span
                className={cn(
                  "mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold",
                  today ? "bg-accent text-on-accent" : "text-ink",
                )}
              >
                {Number(k.slice(8))}
              </span>
            </button>
          );
        })}
      </div>

      {/* All-day row */}
      {hasAllDay && (
        <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }}>
          <div className="py-1.5 pr-2 text-right text-[10px] text-ink-3">All day</div>
          {dayKeys.map((k, i) => (
            <div key={k} className="min-w-0 space-y-0.5 border-l border-border p-1">
              {allDay[i].map((o) => (
                <EventChip
                  key={o.key}
                  occ={o}
                  areas={areas}
                  timeZone={timeZone}
                  conflict={false}
                  showTime={false}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Time grid */}
      <div ref={scroller} className="max-h-[68vh] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: columns, height: 24 * HOUR_PX }}>
          <div className="relative">
            {HOURS.map((h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-3"
                style={{ top: h * HOUR_PX }}
              >
                {h === 0 ? "" : formatMinutes(h * 60)}
              </span>
            ))}
          </div>

          {dayKeys.map((k, i) => {
            const today = k === todayKey;
            return (
              <div
                key={k}
                role="presentation"
                className={cn("relative cursor-copy border-l border-border", today && "bg-accent-soft/30")}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const minutes = ((e.clientY - rect.top) / HOUR_PX) * 60;
                  onCreate(k, Math.min(23 * 60 + 30, Math.max(0, Math.floor(minutes / SNAP_MIN) * SNAP_MIN)));
                }}
              >
                {HOURS.map((h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/70" style={{ top: h * HOUR_PX }} />
                ))}
                {placed[i].map((p) => {
                  const top = (p.startMin / 60) * HOUR_PX;
                  const height = Math.max(((p.endMin - p.startMin) / 60) * HOUR_PX - 2, 18);
                  const width = 100 / p.columns;
                  return (
                    <EventBlock
                      key={p.occ.key}
                      occ={p.occ}
                      areas={areas}
                      timeZone={timeZone}
                      conflict={conflicts.has(p.occ.key)}
                      heightMin={p.endMin - p.startMin}
                      onSelect={onSelect}
                      style={{
                        top: top + 1,
                        height,
                        left: `calc(${p.column * width}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                      }}
                    />
                  );
                })}
                {today && nowMin !== null && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                    style={{ top: (nowMin / 60) * HOUR_PX }}
                  >
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
