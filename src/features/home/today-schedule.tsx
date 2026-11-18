"use client";

import { AreaDot, Card, CardBody, CardHeader, SampleDataBadge, Skeleton } from "@/components/ui";
import { useNow } from "@/lib/hooks/use-now";
import { buildSampleWeek } from "@/lib/placeholder";
import { formatTime, isSameDay, startOfWeek } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import Link from "next/link";

export function TodaySchedule() {
  const now = useNow();

  const items = now
    ? buildSampleWeek(startOfWeek(now, 1))
        .filter((c) => c.startsAt && isSameDay(new Date(c.startsAt), now))
        .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!))
    : null;

  return (
    <Card>
      <CardHeader
        title="Today"
        description="Fixed commitments and flexible work, in order."
        action={<SampleDataBadge />}
      />
      <CardBody>
        {!items ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-ink-3">
            Nothing scheduled today. A good day to rest or get ahead.
          </p>
        ) : (
          <ol className="relative space-y-1.5">
            {items.map((c) => {
              const start = new Date(c.startsAt!);
              const end = new Date(c.endsAt!);
              const live = now! >= start && now! < end;
              const past = now! >= end;
              return (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-center gap-4 rounded-xl px-3 py-2.5 transition-colors",
                    live ? "bg-accent-soft" : "hover:bg-surface-2",
                    past && "opacity-55",
                  )}
                >
                  <div className="w-[72px] shrink-0 text-right text-[13px] tabular-nums text-ink-3">
                    {formatTime(start)}
                  </div>
                  <span
                    className={cn("h-9 w-1 shrink-0 rounded-full", c.kind === "flexible" && "opacity-50")}
                    style={{ background: `var(--cat-${c.area})` }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{c.title}</p>
                    <p className="flex items-center gap-1.5 truncate text-[12px] text-ink-3">
                      {formatTime(start)} – {formatTime(end)}
                      {c.location && <> · {c.location}</>}
                    </p>
                  </div>
                  <span className="hidden shrink-0 text-[11px] font-medium text-ink-3 sm:inline">
                    {live ? <span className="text-accent-ink">Now</span> : c.kind === "fixed" ? "Fixed" : "Flexible"}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-[12px] text-ink-3">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5"><AreaDot area="academics" /> Fixed</span>
            <span className="flex items-center gap-1.5"><AreaDot area="academics" className="opacity-50" /> Flexible</span>
          </span>
          <Link href="/calendar" className="font-medium text-accent-ink hover:underline">
            Open calendar
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
