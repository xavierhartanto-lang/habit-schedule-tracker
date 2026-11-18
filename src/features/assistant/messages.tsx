import { cn } from "@/lib/utils/cn";
import { CalendarPlus, Info, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end animate-fade-up">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-relaxed text-bg sm:max-w-[70%]">
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
        <div className="text-sm leading-relaxed text-ink">{children}</div>
        {footer && <div className="mt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function AssistantAvatar() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
      <Sparkles className="size-3.5" />
    </span>
  );
}

export function SuggestedBlocks({ items }: { items: { day: string; time: string; title: string }[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border bg-surface-2/60 px-3.5 py-2">
        <p className="text-[12px] font-medium text-ink-2">Proposed study blocks</p>
        <span className="text-[11px] text-ink-3">Flexible</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((s) => (
          <li key={s.title} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="w-9 text-[12px] font-semibold text-ink-2">{s.day}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.title}</span>
            <span className="text-[12px] tabular-nums text-ink-3">{s.time}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 border-t border-border px-3.5 py-2.5">
        <button disabled className="h-8 rounded-lg px-3 text-[13px] text-ink-3">Adjust</button>
        <button disabled className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent/60 px-3 text-[13px] font-medium text-white">
          <CalendarPlus className="size-3.5" /> Add to calendar
        </button>
      </div>
    </div>
  );
}

export function ThinkingState({ label = "Looking at your week" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 animate-fade-up">
      <AssistantAvatar />
      <div className="flex items-center gap-2 text-[13px] text-ink-3">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 rounded-full bg-accent animate-pulse-dot" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </span>
        {label}…
      </div>
    </div>
  );
}

export function SystemNotice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-md items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] animate-fade-up",
        tone === "warn" ? "bg-[var(--cat-creative-soft)] text-ink-2" : "bg-surface-2 text-ink-2",
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <span>{children}</span>
    </div>
  );
}
