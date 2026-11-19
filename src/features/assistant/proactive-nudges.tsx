"use client";

import { cn } from "@/lib/utils/cn";
import type { Nudge, ProactiveChip } from "@/features/home/proactive";

/**
 * Proactive suggestions inside the conversation. Deliberately not cards:
 * a short line in the assistant's voice with one or two quiet buttons.
 */

const CHIP =
  "rounded-full border px-3 py-1.5 text-[12.5px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";

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
              ? "border-accent/30 bg-accent-soft font-medium text-accent-ink hover:border-accent/60"
              : c.act.kind === "dismiss"
                ? "border-transparent text-ink-3 hover:text-ink-2"
                : "border-border bg-surface text-ink-2 hover:border-accent/40 hover:bg-accent-soft hover:text-accent-ink",
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
            {n.facts.length > 0 && (
              <p className="mt-1 text-[12px] tabular-nums text-ink-3">{n.facts.join(" · ")}</p>
            )}
            <ChipRow chips={n.chips} onAct={(c) => onAct(n, c)} disabled={disabled} className="mt-2" />
          </li>
        ))}
      </ul>
    </section>
  );
}
