"use client";

import { cn } from "@/lib/utils/cn";
import { Sparkles } from "lucide-react";
import { sendToHomeChat } from "./adaptive/home-bridge";

/**
 * "Plan my day with AI". Runs the existing Plan my day flow (Phase 7.3) in
 * the assistant sheet, so the result is the usual approval card: nothing
 * lands on the calendar until the user approves it.
 *
 * `label` is the engine's own wording ("Plan my day", or "Plan tomorrow"
 * once today has no real time left); it's also what the chat shows as the
 * user's message.
 */
export function PlanDayButton({ label, className }: { label: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => sendToHomeChat({ chip: { label, primary: true, act: { kind: "daily_plan" } }, nudge: null })}
      className={cn(
        "group relative inline-flex h-11 select-none items-center justify-center gap-2 overflow-hidden rounded-2xl bg-accent px-5 text-[14px] font-semibold text-on-accent whitespace-nowrap",
        "shadow-[0_10px_28px_-12px_var(--accent)] transition-[background-color,box-shadow,transform] duration-200 ease-out hover:bg-accent-hover hover:shadow-[0_14px_34px_-12px_var(--accent)] active:scale-[0.98]",
        className,
      )}
    >
      {/* A slow sheen across the button: the one cinematic touch on Home. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 transition-[left,opacity] duration-700 ease-out group-hover:left-full group-hover:opacity-100 motion-reduce:hidden"
      />
      <Sparkles aria-hidden className="size-4" strokeWidth={2.2} />
      {label} with AI
    </button>
  );
}
