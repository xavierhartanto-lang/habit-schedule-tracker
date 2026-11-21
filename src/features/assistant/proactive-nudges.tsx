"use client";

import { cn } from "@/lib/utils/cn";
import type { Nudge, ProactiveChip } from "@/features/home/proactive";
import { CalendarDays, Clock, TriangleAlert } from "lucide-react";
import { factVisual, shortDuration } from "./plan-visual";

/**
 * Proactive suggestions inside the conversation. Deliberately not cards:
 * a short line in the assistant's voice with one or two quiet buttons.
 */

const CHIP =
  "rounded-xl border px-3.5 py-2 text-[13px] font-semibold pointer-coarse:px-3.5 pointer-coarse:py-2.5 pointer-coarse:text-[13.5px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

export function ChipRow({
  chips,
  onAct,
  disabled,
  className,
}: {
  chips: ProactiveChip[];
  onAct: (chip: ProactiveChip) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!chips.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {chips.map((c) => (
        <button
          key={`${c.act.kind}:${c.label}`}
          type="button"
          disabled={disabled}
          onClick={() => onAct(c)}
          className={cn(
            CHIP,
            c.primary
              ? "border-transparent bg-accent text-on-accent shadow-[0_6px_16px_-8px_var(--accent)] hover:bg-accent-hover"
              : c.act.kind === "dismiss"
                ? "border-transparent text-ink-3 hover:text-ink-2"
                : "border-transparent bg-surface-2 text-ink hover:bg-accent-soft hover:text-accent-ink",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** "Also worth a look": at most a couple of lines, each dismissible. */
export function NudgeList({
  nudges,
  lead,
  onAct,
  disabled,
}: {
  nudges: Nudge[];
  lead: string | null;
  onAct: (nudge: Nudge, chip: ProactiveChip) => void;
  disabled?: boolean;
}) {
  if (!nudges.length) return null;
  return (
    <section aria-label="Suggestions" className="space-y-2.5">
      {lead && <p className="text-[12px] font-medium text-ink-3">{lead}</p>}
      <ul className="space-y-3">
        {nudges.map((n) => (
          <li key={n.id} className="animate-fade-up border-l-2 pl-3.5 [border-color:var(--nudge)]" style={{ "--nudge": n.tone === "warning" ? "var(--cat-creative)" : "var(--accent)" } as React.CSSProperties}>
            <p className="max-w-[62ch] text-[14px] leading-relaxed text-ink text-pretty">{n.message}</p>
            <FactRow facts={n.facts} />
            <ChipRow chips={n.chips} onAct={(c) => onAct(n, c)} disabled={disabled} className="mt-2" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A nudge's facts as a work-vs-free bar plus short chips, instead of a sentence. */
export function FactRow({ facts }: { facts: readonly string[] }) {
  if (!facts.length) return null;
  const { capacity, chips } = factVisual(facts);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {capacity && <CapacityBar work={capacity.work} free={capacity.free} />}
      {chips.map((c) => {
        const Icon = c.kind === "due" ? CalendarDays : c.kind === "time" ? Clock : c.kind === "warn" ? TriangleAlert : null;
        return (
          <span
            key={c.label}
            className={cn("inline-flex items-center gap-1 text-[12px] tabular-nums", c.kind === "warn" ? "text-[var(--cat-creative)]" : "text-ink-3")}
          >
            {Icon && <Icon aria-hidden className="size-3" />}
            {c.label}
          </span>
        );
      })}
    </div>
  );
}

/** Work left against free time: the bar fills as work eats the free time, red when it doesn't fit. */
export function CapacityBar({ work, free }: { work: number; free: number }) {
  const over = work > free;
  const fill = Math.min(work / Math.max(free, 1), 1);
  return (
    <div role="img" aria-label={`${shortDuration(work)} of work, ${shortDuration(free)} free`} className="flex items-center gap-2 text-[12px] tabular-nums text-ink-3">
      <span className="relative h-2 w-28 overflow-hidden rounded-full bg-surface-2 sm:w-36">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-danger" : "bg-[var(--cat-creative)]")}
          style={{ width: `${(work > 0 ? Math.max(fill, 0.04) : 0) * 100}%` }}
        />
      </span>
      <span>
        <b className="font-semibold text-ink">{shortDuration(work)}</b> work · <b className="font-semibold text-ink">{shortDuration(free)}</b> free
      </span>
    </div>
  );
}
