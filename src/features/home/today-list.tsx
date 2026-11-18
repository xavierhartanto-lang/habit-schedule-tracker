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
          <Skeleton key={i.key} className="h-11" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-xl bg-surface-2 px-4 py-5 text-center text-[13px] text-ink-3">
        Nothing on the calendar today.{" "}
        <Link href="/calendar?view=day" className="font-medium text-accent-ink hover:underline">
          Add an event
        </Link>
      </p>
    );
  }
  return (
    <ol className="-mx-2 space-y-0.5">
      {items.map((c) => {
        const start = new Date(c.start);
        const end = new Date(c.end);
        const live = !c.allDay && now >= start && now < end;
        const past = !c.allDay && now >= end;
        return (
          <li
            key={c.key}
            className={cn(
              "flex items-center gap-3 rounded-xl px-2 py-2 transition-colors",
              live ? "bg-accent-soft" : "hover:bg-surface-2",
              past && "opacity-55",
            )}
          >
            <div className="w-[60px] shrink-0 text-right text-[12px] tabular-nums text-ink-3">
              {c.allDay ? "All day" : formatTimeInZone(start, timeZone)}
            </div>
            <span
              className={cn("h-8 w-1 shrink-0 rounded-full", c.kind === "flexible" && "opacity-40")}
              style={{ background: areaColors(findArea(areas, c.areaId)).color }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{c.title}</p>
              <p className="truncate text-[12px] text-ink-3">
                {c.allDay ? "All day" : `${formatTimeInZone(start, timeZone)} – ${formatTimeInZone(end, timeZone)}`}
                {c.location && <> · {c.location}</>}
              </p>
            </div>
            {live && <span className="shrink-0 text-[11px] font-medium text-accent-ink">Now</span>}
          </li>
        );
      })}
    </ol>
  );
}
