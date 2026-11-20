"use client";

import { Skeleton } from "@/components/ui";
import { areaColors, findArea } from "@/lib/domain/life-areas";
import type { CommitmentKind, LifeAreaRecord } from "@/lib/domain/types";
import { useNow } from "@/lib/hooks/use-now";
import { formatTimeInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import Link from "next/link";

export type TodayItem = {
  key: string;
  title: string;
  location: string | null;
  kind: CommitmentKind;
  allDay: boolean;
  start: string;
  end: string;
  areaId: string | null;
};

/** Highlights what is happening now; needs the client clock. */
export function TodayList({ items, areas, timeZone }: { items: TodayItem[]; areas: LifeAreaRecord[]; timeZone: string }) {
  const now = useNow();
  if (!now) {
    return (
      <div className="space-y-2">
        {items.slice(0, 3).map((i) => (
          <Skeleton key={i.key} className="h-10" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-ink-3">
        Nothing on the calendar today.{" "}
        <Link href="/calendar?view=day" className="font-medium text-accent-ink hover:underline">
          Add an event
        </Link>
      </p>
    );
  }
  return (
    <ol className="-mx-2 space-y-1">
      {items.map((c) => {
        const start = new Date(c.start);
        const end = new Date(c.end);
        const live = !c.allDay && now >= start && now < end;
        const past = !c.allDay && now >= end;
        return (
          <li
            key={c.key}
            className={cn(
              "flex items-center gap-3 rounded-[14px] px-2.5 py-2 transition-colors",
              live ? "bg-accent-soft" : "hover:bg-surface-2",
              past && "opacity-50",
            )}
          >
            <div className={cn("w-[58px] shrink-0 text-right text-[12px] tabular-nums", live ? "text-accent-ink" : "text-ink-3")}>
              {c.allDay ? "All day" : formatTimeInZone(start, timeZone)}
            </div>
            <span
              className={cn("w-1 shrink-0 self-stretch rounded-full", c.kind === "flexible" && "opacity-40")}
              style={{ background: areaColors(findArea(areas, c.areaId)).color }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-ink">{c.title}</p>
              <p className="truncate text-[12px] tabular-nums text-ink-3">
                {c.allDay ? "All day" : `${formatTimeInZone(start, timeZone)} – ${formatTimeInZone(end, timeZone)}`}
                {c.location && <> · {c.location}</>}
              </p>
              {live && (
                <div
                  role="progressbar"
                  aria-label="Time elapsed"
                  aria-valuenow={Math.round(elapsed(start, end, now) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent/15"
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${elapsed(start, end, now) * 100}%` }} />
                </div>
              )}
            </div>
            {live && (
              <span className="flex shrink-0 items-center gap-1 self-start pt-0.5 text-[11px] font-bold uppercase tracking-wide text-accent-ink">
                <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                Now
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function elapsed(start: Date, end: Date, now: Date) {
  const span = end.getTime() - start.getTime();
  return span > 0 ? Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span)) : 0;
}
