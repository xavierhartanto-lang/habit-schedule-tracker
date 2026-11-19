"use client";

import { Skeleton } from "@/components/ui";
import { areaColors, findArea } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import { useNow } from "@/lib/hooks/use-now";
import { formatTimeInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ChevronRight, MapPin } from "lucide-react";
import Link from "next/link";

export type NextItem = {
  key: string;
  title: string;
  location: string | null;
  start: string;
  end: string;
  areaId: string | null;
  tomorrow: boolean;
};

function until(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m && h < 3 ? `in ${h} h ${m} min` : `in ${h} h`;
}

/** "Now" or "Up next" card. Needs the client clock, so it renders a skeleton on the server. */
export function GlanceNext({ items, areas, timeZone }: { items: NextItem[]; areas: LifeAreaRecord[]; timeZone: string }) {
  const now = useNow();
  if (!now) return <Skeleton className="h-[76px] rounded-2xl" />;

  const live = items.find((i) => !i.tomorrow && new Date(i.start) <= now && new Date(i.end) > now);
  const next = items.find((i) => new Date(i.start) > now);
  const item = live ?? next;
  const restToday = items.filter((i) => !i.tomorrow && new Date(i.start) > now).length - (live ? 0 : 1);

  const label = live
    ? "Now"
    : !item
      ? "Today"
      : item.tomorrow
        ? "Tomorrow"
        : `Up next · ${until(new Date(item.start).getTime() - now.getTime())}`;
  const color = item ? areaColors(findArea(areas, item.areaId)).color : "var(--border-strong)";

  return (
    <Link
      href="/calendar?view=day"
      className="group relative flex min-h-[76px] items-center gap-3.5 overflow-hidden rounded-2xl border border-border bg-surface p-3.5 pl-4 shadow-card transition-[transform,background-color,border-color] duration-150 ease-out hover:border-border-strong active:scale-[0.98] active:bg-surface-2"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-24 opacity-[0.14]"
        style={{ background: `linear-gradient(90deg, ${color}, transparent)` }}
      />
      <span aria-hidden className="relative h-10 w-1 shrink-0 rounded-full" style={{ background: color }} />
      <span className="relative min-w-0 flex-1">
        <span className={cn("flex items-center gap-1.5 text-[11.5px] font-medium", live ? "text-accent-ink" : "text-ink-3")}>
          {live && <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-accent" />}
          {label}
        </span>
        {item ? (
          <>
            <span className="mt-0.5 block truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">{item.title}</span>
            <span className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] tabular-nums text-ink-3">
              {formatTimeInZone(new Date(item.start), timeZone)} – {formatTimeInZone(new Date(item.end), timeZone)}
              {item.location && (
                <>
                  <MapPin className="ml-1 size-3 shrink-0" />
                  <span className="truncate">{item.location}</span>
                </>
              )}
            </span>
          </>
        ) : (
          <span className="mt-0.5 block text-[16px] font-semibold tracking-[-0.01em] text-ink">Nothing else on the calendar</span>
        )}
      </span>
      <span className="relative flex shrink-0 items-center gap-1 text-[12px] text-ink-3">
        {!item?.tomorrow && restToday > 0 && <span className="tabular-nums">+{restToday}</span>}
        <ChevronRight className="size-4" />
      </span>
    </Link>
  );
}
