import { LIFE_AREAS } from "@/lib/domain/life-areas";
import type { Commitment } from "@/lib/domain/types";
import { formatTime } from "@/lib/scheduling/time";
import { cn } from "@/lib/utils/cn";
import { Lock, MoveVertical } from "lucide-react";

/**
 * Visual language:
 *  fixed    → solid tinted block, solid accent edge, lock icon.
 *  flexible → dashed outline on the page background, movable icon.
 */
export function EventBlock({ c, style }: { c: Commitment; style: React.CSSProperties }) {
  const area = LIFE_AREAS[c.area];
  const start = new Date(c.startsAt!);
  const end = new Date(c.endsAt!);
  const short = end.getTime() - start.getTime() <= 50 * 60_000;
  const fixed = c.kind === "fixed";

  return (
    <div
      className={cn(
        "absolute inset-x-1 overflow-hidden rounded-lg px-2 py-1 text-left transition-shadow hover:shadow-pop",
        fixed ? "border-l-[3px]" : "border border-dashed",
      )}
      style={{
        ...style,
        background: fixed ? area.soft : "var(--surface)",
        borderColor: area.color,
      }}
      title={`${c.title} · ${fixed ? "Fixed" : "Flexible"}`}
    >
      <div className="flex items-start gap-1">
        <p className={cn("min-w-0 flex-1 truncate text-[12px] font-medium leading-tight text-ink", short && "text-[11px]")}>
          {c.title}
        </p>
        {fixed ? (
          <Lock className="mt-px size-3 shrink-0 text-ink-3" aria-label="Fixed" />
        ) : (
          <MoveVertical className="mt-px size-3 shrink-0 text-ink-3" aria-label="Flexible" />
        )}
      </div>
      {!short && (
        <p className="mt-0.5 truncate text-[11px] leading-tight text-ink-3">
          {formatTime(start)} – {formatTime(end)}
        </p>
      )}
    </div>
  );
}
