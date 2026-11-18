import { Card } from "@/components/ui";
import { SUGGESTED_PROMPTS } from "@/lib/placeholder";
import { ArrowUpRight, Sparkles } from "lucide-react";
import Link from "next/link";

export function AssistantQuickAccess() {
  return (
    <Card className="overflow-hidden">
      <div className="p-5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent">
            <Sparkles className="size-4" />
          </span>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Plan with your assistant</h2>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Talk through a busy week. It will learn your routines and suggest where things fit.
        </p>
        <Link
          href="/assistant"
          className="mt-4 flex h-10 items-center justify-between rounded-xl border border-border bg-surface-2 px-3.5 text-sm text-ink-3 transition-colors hover:border-accent/40 hover:text-ink-2"
        >
          Ask about your week…
          <ArrowUpRight className="size-4" />
        </Link>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border bg-surface-2/50 px-5 py-3">
        {SUGGESTED_PROMPTS.slice(0, 2).map((p) => (
          <Link
            key={p}
            href="/assistant"
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:text-ink"
          >
            {p}
          </Link>
        ))}
      </div>
    </Card>
  );
}
