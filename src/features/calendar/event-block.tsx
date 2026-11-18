"use client";

import { areaColors, findArea } from "@/lib/domain/life-areas";
import type { LifeAreaRecord } from "@/lib/domain/types";
import type { Occurrence } from "@/lib/scheduling/recurrence";
import { formatTimeInZone } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import { Lock, MoveVertical, Repeat, TriangleAlert } from "lucide-react";

/**
 * Visual language:
 *  fixed    → solid tinted block, solid area-colored edge, lock icon.
 *  flexible → dashed outline on the page background, movable icon.
 *  overlap  → warning icon and a red ring.
 */
export function EventBlock({
  occ,
  areas,
  timeZone,
  conflict,
  style,
  heightMin,
  onSelect,
}: {
  occ: Occurrence;
  areas: readonly LifeAreaRecord[];
  timeZone: string;
  conflict: boolean;
  style: React.CSSProperties;
  heightMin: number;
  onSelect: (o: Occurrence) => void;
}) {
  const e = occ.event;
  const colors = areaColors(findArea(areas, e.lifeAreaId));
  const fixed = e.kind === "fixed";
  const short = heightMin <= 45;
  const time = `${formatTimeInZone(occ.start, timeZone)} – ${formatTimeInZone(occ.end, timeZone)}`;

  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onSelect(occ);
      }}
      className={cn(
        "absolute overflow-hidden rounded-lg px-1.5 py-1 text-left transition-shadow hover:z-20 hover:shadow-pop focus-visible:z-20",
        fixed ? "border-l-[3px]" : "border border-dashed",
        conflict && "ring-1 ring-danger/70",
      )}
      style={{
        ...style,
        background: fixed ? colors.soft : "var(--surface)",
        borderColor: colors.color,
      }}
      title={`${e.title} · ${time} · ${fixed ? "Fixed" : "Flexible"}${conflict ? " · Overlaps another event" : ""}`}
    >
      <span className="flex items-start gap-1">
        <span className={cn("min-w-0 flex-1 truncate text-[12px] font-medium leading-tight text-ink", short && "text-[11px]")}>
          {e.title}
        </span>
        {conflict && <TriangleAlert className="mt-px size-3 shrink-0 text-danger" aria-label="Overlaps another event" />}
        {occ.recurring && <Repeat className="mt-px size-3 shrink-0 text-ink-3" aria-label="Repeats" />}
        {fixed ? (
          <Lock className="mt-px size-3 shrink-0 text-ink-3" aria-label="Fixed" />
        ) : (
          <MoveVertical className="mt-px size-3 shrink-0 text-ink-3" aria-label="Flexible" />
        )}
      </span>
      {!short && <span className="mt-0.5 block truncate text-[11px] leading-tight text-ink-3">{time}</span>}
    </button>
  );
}

/** Compact one-line chip for all-day rows and the month grid. */
export function EventChip({
  occ,
  areas,
  timeZone,
  conflict,
  showTime,
  onSelect,
}: {
  occ: Occurrence;
  areas: readonly LifeAreaRecord[];
  timeZone: string;
  conflict: boolean;
  showTime: boolean;
  onSelect: (o: Occurrence) => void;
}) {
  const e = occ.event;
  const colors = areaColors(findArea(areas, e.lifeAreaId));
  const fixed = e.kind === "fixed";
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onSelect(occ);
      }}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight transition-colors hover:brightness-95",
        occ.allDay ? (fixed ? "" : "border border-dashed") : "hover:bg-surface-2",
      )}
      style={
        occ.allDay
          ? { background: fixed ? colors.soft : "var(--surface)", borderColor: colors.color }
          : undefined
      }
      title={e.title}
    >
      {!occ.allDay && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", !fixed && "border border-current bg-transparent")}
          style={fixed ? { background: colors.color } : { color: colors.color }}
        />
      )}
      {showTime && !occ.allDay && (
        <span className="shrink-0 tabular-nums text-ink-3">{formatTimeInZone(occ.start, timeZone).replace(":00", "")}</span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.title}</span>
      {conflict && <TriangleAlert className="size-3 shrink-0 text-danger" aria-label="Overlaps another event" />}
    </button>
  );
}
