import { cn } from "@/lib/utils/cn";
import type { ReactNode } from "react";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Marks UI that is rendering sample content from lib/placeholder.
 * Required wherever placeholder data appears.
 */
export function SampleDataBadge({ className }: { className?: string }) {
  return (
    <span
      title="This section shows sample content until your data is connected."
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3",
        className,
      )}
    >
      Sample data
    </span>
  );
}
