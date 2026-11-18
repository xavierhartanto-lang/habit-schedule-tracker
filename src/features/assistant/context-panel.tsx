import type { OnboardingCoverage } from "@/lib/ai/prompts";
import { cn } from "@/lib/utils/cn";
import { ArrowUpRight, Brain, Check, Compass, ShieldCheck } from "lucide-react";
import Link from "next/link";

export const CONTEXT_REVIEW_HREF = "/about-you";

/** What the assistant can see right now, with links to review and control it. */
export function ContextPanel({
  coverage,
  factCount,
  personalization,
  memory,
  onboarded,
}: {
  coverage: OnboardingCoverage | null;
  factCount: number;
  personalization: boolean;
  memory: boolean;
  onboarded: boolean;
}) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-5 xl:flex" aria-label="What the assistant knows">
      <div>
        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <Brain className="size-4 text-accent" /> What it knows
        </p>
        {!personalization ? (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Personalization is off, so the assistant only uses what you say in this chat.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[13px] text-ink-2">
              {factCount === 0
                ? "Nothing saved yet. Facts you save from chats show up here."
                : `${factCount} saved ${factCount === 1 ? "fact" : "facts"} about your week.`}
            </p>
            {coverage && (
              <ul className="mt-3 space-y-1.5">
                {coverage.topics.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-[13px]">
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full",
                        t.covered ? "bg-accent text-white" : "border border-border-strong",
                      )}
                    >
                      {t.covered && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className={t.covered ? "text-ink" : "text-ink-3"}>{t.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <Link
          href={CONTEXT_REVIEW_HREF}
          className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent-ink hover:underline"
        >
          What Whitespace knows <ArrowUpRight className="size-3.5" />
        </Link>
      </div>

      {!onboarded && (
        <Link
          href="/onboarding"
          className="flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent-soft/50 p-3.5 transition-colors hover:border-accent/50"
        >
          <Compass className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            <span className="block text-[13px] font-medium text-ink">Finish setup</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-3">
              A short conversation so Whitespace understands your week.
            </span>
          </span>
        </Link>
      )}

      <div className="rounded-xl bg-surface-2 p-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <ShieldCheck className="size-4 text-success" /> You stay in control
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          Nothing is saved until you tap Save, and the assistant never changes your calendar.
          {personalization && !memory && " Memory is off, so facts learned in chats aren't used."}
        </p>
        <Link href="/settings#ai" className="mt-2 inline-block text-[12px] font-medium text-accent-ink hover:underline">
          AI settings
        </Link>
      </div>
    </aside>
  );
}
