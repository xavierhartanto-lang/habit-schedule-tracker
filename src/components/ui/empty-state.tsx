import { cn } from "@/lib/utils/cn";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center rounded-xl bg-surface-2/60 px-6 py-10 text-center", className)}>
      {Icon && (
        <span className="mb-3 grid size-10 place-items-center rounded-xl bg-surface text-ink-3 shadow-card">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Dashed banner for preview mode, signed-out and load errors. */
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "rounded-xl border border-dashed px-4 py-3 text-[13px]",
        tone === "danger" ? "border-danger/50 text-danger" : "border-border-strong text-ink-2",
      )}
    >
      {children}
    </div>
  );
}
