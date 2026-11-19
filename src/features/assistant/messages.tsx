import { cn } from "@/lib/utils/cn";
import { Info, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export function UserMessage({ children, pending }: { children: ReactNode; pending?: boolean }) {
  return (
    <div className="flex justify-end animate-fade-up">
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface-2 px-4 py-2.5 text-sm leading-relaxed text-ink transition-opacity sm:max-w-[70%]",
          pending && "opacity-60",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Assistant turns read like notes from a planner, not chat bubbles. */
export function AssistantMessage({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex gap-3 animate-fade-up">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="break-words text-[14.5px] leading-relaxed text-ink">{children}</div>
        {footer && <div className="mt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function AssistantAvatar() {
  return (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent ring-1 ring-inset ring-accent/15">
      <Sparkles className="size-3.5" />
    </span>
  );
}

export function ThinkingState({ label = "Looking at your week" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 animate-fade-up">
      <AssistantAvatar />
      <div role="status" className="flex items-center gap-2 text-[13px] text-ink-3">
        <span aria-hidden className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 rounded-full bg-accent animate-pulse-dot" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </span>
        {label}…
      </div>
    </div>
  );
}

export function SystemNotice({
  children,
  tone = "info",
  action,
}: {
  children: ReactNode;
  tone?: "info" | "warn";
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-md items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] animate-fade-up",
        tone === "warn" ? "bg-[var(--cat-creative-soft)] text-ink-2 ring-1 ring-inset ring-[var(--cat-creative)]/20" : "bg-surface-2 text-ink-2",
      )}
    >
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
