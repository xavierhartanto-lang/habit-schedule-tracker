"use client";

import { Skeleton } from "@/components/ui";
import { areaColors, findArea } from "@/lib/domain/life-areas";
import type { CommitmentKind, LifeAreaRecord, SessionOutcome } from "@/lib/domain/types";
import { useNow } from "@/lib/hooks/use-now";
import { formatTimeInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { ChevronDown, MapPin } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SessionOutcomeChips } from "./session-outcome";

export type TodayItem = {
  key: string;
  title: string;
  location: string | null;
  kind: CommitmentKind;
  allDay: boolean;
  start: string;
  end: string;
  areaId: string | null;
  /** Set for a Whitespace work session: its id, so the user can say whether it happened. */
  sessionId?: string | null;
  outcome?: SessionOutcome | null;
};

/** Earlier blocks fold away once there are more than this many, so now and next stay in front. */
const KEEP_PAST = 1;

export function until(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m && h < 3 ? `in ${h} h ${m} min` : `in ${h} h`;
}

/** One line under "Your today": what's happening and what's left, from the clock. */
export function TodaySummary({ items, timeZone }: { items: TodayItem[]; timeZone: string }) {
  const now = useNow();
  if (!now) return <Skeleton className="mt-2 h-4 w-56" />;
  const timed = items.filter((i) => !i.allDay);
  const live = timed.find((i) => new Date(i.start) <= now && new Date(i.end) > now);
  const left = timed.filter((i) => new Date(i.start) > now);
  const lastEnd = timed.length ? new Date(Math.max(...timed.map((i) => new Date(i.end).getTime()))) : null;

  let text: string;
  if (!timed.length) text = "Nothing scheduled. The day is yours to shape.";
  else if (live) text = left.length ? `${live.title} now · ${left.length} more after` : `${live.title} now · last one today`;
  else if (left.length) text = `${left.length} ${left.length === 1 ? "block" : "blocks"} left · next ${until(new Date(left[0].start).getTime() - now.getTime())}`;
  else text = `All done for today${lastEnd ? ` · free since ${formatTimeInZone(lastEnd, timeZone)}` : ""}`;

  return <p className="mt-1.5 truncate text-[14px] tabular-nums text-ink-2">{text}</p>;
}

/**
 * Today as a calm vertical timeline: a rail of time, each block on it in
 * its area's color, the current one lifted with a live progress bar, and
 * a "now" marker between blocks when nothing is on. Needs the client clock.
 */
export function TodayTimeline({ items, areas, timeZone }: { items: TodayItem[]; areas: LifeAreaRecord[]; timeZone: string }) {
  const now = useNow();
  const [showPast, setShowPast] = useState(false);

  if (!now) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-2xl" />
        ))}
      </div>
    );
  }

  const allDay = items.filter((i) => i.allDay);
  const timed = items.filter((i) => !i.allDay);

  if (!timed.length && !allDay.length) {
    return (
      <div className="flex flex-col items-start gap-1 rounded-2xl border border-dashed border-border-strong/70 px-5 py-6">
        <p className="text-[15px] font-medium text-ink">An open day.</p>
        <p className="text-[13.5px] leading-relaxed text-ink-3">
          Let the assistant suggest focus blocks, or{" "}
          <Link href="/calendar?view=day" className="font-medium text-accent-ink hover:underline">
            add something yourself
          </Link>
          .
        </p>
      </div>
    );
  }

  const past = timed.filter((i) => new Date(i.end) <= now);
  // Sessions that already started but have no outcome yet stay visible, so they can be answered.
  const hidden = showPast || past.length <= KEEP_PAST ? [] : past.slice(0, past.length - KEEP_PAST).filter((i) => !(i.sessionId && !i.outcome));
  const hiddenKeys = new Set(hidden.map((i) => i.key));
  const shown = timed.filter((i) => !hiddenKeys.has(i.key));
  const nextKey = timed.find((i) => new Date(i.start) > now)?.key ?? null;
  const live = timed.some((i) => new Date(i.start) <= now && new Date(i.end) > now);
  // Where the "now" marker goes when nothing is on: before the next block, or after the last.
  const markerBefore = !live ? nextKey : null;
  const markerAtEnd = !live && !nextKey && timed.length > 0;

  return (
    <div>
      {allDay.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-1.5" aria-label="All day">
          {allDay.map((i) => (
            <li
              key={i.key}
              className="inline-flex max-w-full items-center gap-2 rounded-full bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: areaColors(findArea(areas, i.areaId)).color }} />
              <span className="truncate">{i.title}</span>
              <span className="text-ink-3">All day</span>
            </li>
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowPast(true)}
          className="mb-1 ml-[76px] flex items-center gap-1 rounded-full px-2 py-1 text-[12.5px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2 sm:ml-[84px]"
        >
          <ChevronDown className="size-3.5" />
          {hidden.length === 1 ? "1 earlier block" : `${hidden.length} earlier blocks`}
        </button>
      )}

      <ol className="relative">
        {/* The time rail. */}
        <span aria-hidden className="absolute bottom-3 left-[67px] top-3 w-px bg-border sm:left-[75px]" />
        {shown.map((c) => (
          <Block
            key={c.key}
            item={c}
            now={now}
            timeZone={timeZone}
            areas={areas}
            next={c.key === nextKey}
            markerBefore={c.key === markerBefore}
          />
        ))}
        {markerAtEnd && <NowMarker now={now} timeZone={timeZone} />}
      </ol>
    </div>
  );
}

function NowMarker({ now, timeZone }: { now: Date; timeZone: string }) {
  return (
    <li aria-label={`Now, ${formatTimeInZone(now, timeZone)}`} className="relative flex items-center py-1.5">
      <span className="w-[60px] shrink-0 text-right text-[11.5px] font-semibold tabular-nums text-accent-ink sm:w-[68px]">
        {formatTimeInZone(now, timeZone)}
      </span>
      <span aria-hidden className="relative ml-[3px] grid size-2.5 place-items-center">
        <span className="absolute size-2.5 animate-ping rounded-full bg-accent/40 motion-reduce:hidden" />
        <span className="size-2.5 rounded-full bg-accent ring-4 ring-surface" />
      </span>
      <span aria-hidden className="ml-2 h-px flex-1 bg-gradient-to-r from-accent/70 to-transparent" />
    </li>
  );
}

function Block({
  item: c,
  now,
  timeZone,
  areas,
  next,
  markerBefore,
}: {
  item: TodayItem;
  now: Date;
  timeZone: string;
  areas: LifeAreaRecord[];
  next: boolean;
  markerBefore: boolean;
}) {
  const start = new Date(c.start);
  const end = new Date(c.end);
  const live = now >= start && now < end;
  const past = now >= end;
  const color = areaColors(findArea(areas, c.areaId)).color;
  const progress = live ? Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / Math.max(1, end.getTime() - start.getTime()))) : 0;

  return (
    <>
      {markerBefore && <NowMarker now={now} timeZone={timeZone} />}
      <li className="relative flex items-stretch gap-0 py-1">
        <div
          className={cn(
            "w-[60px] shrink-0 pt-3 text-right text-[12.5px] font-medium tabular-nums sm:w-[68px]",
            live ? "text-accent-ink" : "text-ink-3",
            past && "opacity-50",
          )}
        >
          {formatTimeInZone(start, timeZone)}
        </div>
        {/* Dot on the rail. */}
        <span aria-hidden className="relative ml-[3px] flex w-2.5 shrink-0 justify-center pt-[17px]">
          <span
            className={cn("size-2.5 rounded-full ring-4 ring-surface", past && "opacity-40", c.kind === "flexible" && !live && "bg-surface ring-2")}
            style={c.kind === "flexible" && !live ? { boxShadow: `inset 0 0 0 2px ${color}` } : { background: color }}
          />
        </span>
        <div
          className={cn(
            "ml-3 min-w-0 flex-1 rounded-2xl px-4 py-2.5 transition-colors",
            live ? "bg-accent-soft ring-1 ring-accent/25" : next ? "bg-surface-2" : "",
            past && "opacity-55",
          )}
        >
          {live ? (
            <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-accent-ink">
              <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
              Now
            </p>
          ) : next ? (
            <p className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.08em] tabular-nums text-ink-3">Next · {until(start.getTime() - now.getTime())}</p>
          ) : null}
          <p className={cn("truncate font-semibold tracking-[-0.01em] text-ink", live || next ? "text-[16px]" : "text-[14.5px]")}>{c.title}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] tabular-nums text-ink-3">
            {formatTimeInZone(start, timeZone)} – {formatTimeInZone(end, timeZone)}
            {c.location && (
              <>
                <MapPin aria-hidden className="ml-1.5 size-3 shrink-0" />
                <span className="truncate">{c.location}</span>
              </>
            )}
          </p>
          {live && (
            <div
              role="progressbar"
              aria-label="Time elapsed"
              aria-valuenow={Math.round(progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-2.5 h-1 overflow-hidden rounded-full bg-accent/15"
            >
              <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          {/* Plan vs reality: once a work session has started, the user can say how it went. */}
          {c.sessionId && (live || past) && (
            <div className="mt-2">
              <SessionOutcomeChips id={c.sessionId} outcome={c.outcome ?? null} />
            </div>
          )}
        </div>
      </li>
    </>
  );
}
