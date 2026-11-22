"use client";

import type { TaskPriority } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";

/**
 * Priority is the main field of a task. Due dates are optional extras.
 * One look everywhere: a colored dot plus the word.
 */

export const PRIORITIES: readonly TaskPriority[] = ["high", "medium", "low"];

export const PRIORITY_LABEL: Record<TaskPriority, string> = { high: "High", medium: "Medium", low: "Low" };

const DOT: Record<TaskPriority, string> = {
  high: "bg-danger",
  medium: "bg-accent",
  low: "bg-ink-3/60",
};

export const PRIORITY_TEXT: Record<TaskPriority, string> = {
  high: "text-danger",
  medium: "text-accent-ink",
  low: "text-ink-3",
};

export function PriorityDot({ priority, className }: { priority: TaskPriority; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[priority], className)} />;
}

/** Small label for rows: dot + word. */
export function PriorityTag({ priority, className }: { priority: TaskPriority; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-medium", PRIORITY_TEXT[priority], className)}>
      <PriorityDot priority={priority} />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/** Three-way picker. The selected option shows its color. */
export function PriorityPicker({
  value,
  onChange,
  disabled,
  size = "md",
  className,
}: {
  value: TaskPriority;
  onChange: (p: TaskPriority) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Priority" className={cn("flex rounded-lg border border-border bg-surface-2 p-0.5", className)}>
      {PRIORITIES.map((p) => {
        const on = value === p;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(p)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,color,box-shadow] duration-150 pointer-coarse:active:scale-[0.97] disabled:opacity-50",
              size === "sm" ? "h-7 px-2.5 text-[12.5px] pointer-coarse:h-9" : "h-8 px-3 text-[13px] pointer-coarse:h-10",
              on ? cn("bg-surface shadow-card ring-1 ring-inset ring-border", PRIORITY_TEXT[p]) : "text-ink-3 hover:text-ink-2",
            )}
          >
            <PriorityDot priority={p} className={on ? undefined : "opacity-50"} />
            {PRIORITY_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}
