"use client";

import type { LifeAreaRecord } from "@/lib/domain/types";
import { occurrencesOn } from "@/lib/scheduling/layout";
import type { Occurrence } from "@/lib/scheduling/recurrence";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { useMemo } from "react";
import { EventChip } from "./event-block";

const MAX_CHIPS = 3;

/** Month view: six weeks, up to three events per day, "+N more" opens the day. */
export function MonthGrid({
  dayKeys,
  monthKey,
  occurrences,
  conflicts,
  areas,
  timeZone,
  todayKey,
  onOpenDay,
  onSelect,
  onCreate,
}: {
  dayKeys: string[];
  monthKey: string;
  occurrences: Occurrence[];
  conflicts: Map<string, string[]>;
  areas: LifeAreaRecord[];
  timeZone: string;
  todayKey: string;
  onOpenDay: (dateKey: string) => void;
  onSelect: (o: Occurrence) => void;
  onCreate: (dateKey: string) => void;
}) {
  const byDay = useMemo(
    () => dayKeys.map((k) => occurrencesOn(occurrences, k, timeZone)),
    [dayKeys, occurrences, timeZone],
  );
  const month = monthKey.slice(0, 7);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="grid grid-cols-7 border-b border-border">
        {dayKeys.slice(0, 7).map((k) => (
          <div key={k} className="py-2 text-center text-[11px] font-medium uppercase tracking-wide text-ink-3">
            <span className="sm:hidden">{formatDateKey(k, { weekday: "narrow" })}</span>
            <span className="hidden sm:inline">{formatDateKey(k, { weekday: "short" })}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {dayKeys.map((k, i) => {
          const list = byDay[i];
          const inMonth = k.slice(0, 7) === month;
          const today = k === todayKey;
          const extra = list.length - MAX_CHIPS;
          return (
            <div
              key={k}
              role="presentation"
              onClick={() =>
                // Phones show dots only, so a tap opens the day; larger screens add an event.
                window.matchMedia("(min-width: 640px)").matches ? onCreate(k) : onOpenDay(k)
              }
              className={cn(
                "min-h-[76px] min-w-0 cursor-copy border-border p-1 sm:min-h-[112px]",
                i % 7 !== 0 && "border-l",
                i >= 7 && "border-t",
                !inMonth && "bg-surface-2/50",
              )}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDay(k);
                }}
                aria-label={`Open ${formatDateKey(k, { weekday: "long", month: "long", day: "numeric" })}`}
                className={cn(
                  "mb-0.5 grid size-6 place-items-center rounded-full text-[12px] font-medium hover:bg-surface-2",
                  today ? "bg-accent text-on-accent hover:bg-accent" : inMonth ? "text-ink" : "text-ink-3",
                )}
              >
                {Number(k.slice(8))}
              </button>

              {/* Phones: dots only. Larger screens: chips. */}
              <div className="flex flex-wrap gap-0.5 sm:hidden">
                {list.slice(0, 4).map((o) => (
                  <span
                    key={o.key}
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: `var(--area-${areas.find((a) => a.id === o.event.lifeAreaId)?.color ?? "none"})` }}
                  />
                ))}
              </div>
              <div className="hidden space-y-0.5 sm:block">
                {list.slice(0, MAX_CHIPS).map((o) => (
                  <EventChip
                    key={o.key}
                    occ={o}
                    areas={areas}
                    timeZone={timeZone}
                    conflict={conflicts.has(o.key)}
                    showTime
                    onSelect={onSelect}
                  />
                ))}
                {extra > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(k);
                    }}
                    className="px-1.5 text-[11px] font-medium text-ink-3 hover:text-ink"
                  >
                    +{extra} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
