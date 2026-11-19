import { Brand } from "@/components/shell/brand";
import { Chat } from "@/features/assistant/chat";
import { CONTEXT_REVIEW_HREF } from "@/features/assistant/context-panel";
import { ChatPageState, ChatSkeleton } from "@/features/assistant/page-states";
import { loadOnboardingPage } from "@/features/assistant/server/load";
import { FinishButton } from "@/features/onboarding/finish-button";
import type { OnboardingCoverage } from "@/lib/ai/prompts";
import { cn } from "@/lib/utils/cn";
import { Check, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Set up Whitespace" };

/**
 * First-run setup as a conversation. Topics fill in as the user saves what
 * the assistant noticed, never from what it guessed.
 */
export default function OnboardingPage() {
  return (
    <div className="flex h-dvh flex-col bg-bg pb-[env(safe-area-inset-bottom)]">
      <header className="box-content flex h-14 shrink-0 items-center pt-[env(safe-area-inset-top)] justify-between border-b border-border bg-surface/80 px-4 backdrop-blur sm:px-6">
        <Brand />
        <p className="hidden text-[13px] text-ink-3 sm:block">Setup · a quick conversation</p>
        <Suspense fallback={<span className="w-24" />}>
          <SkipLink />
        </Suspense>
      </header>
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1">
            <div className="flex-1">
              <ChatSkeleton />
            </div>
          </div>
        }
      >
        <OnboardingContent />
      </Suspense>
    </div>
  );
}

async function SkipLink() {
  const data = await loadOnboardingPage();
  if (data.state !== "ready") return <span className="w-24" />;
  return <FinishButton label="Skip for now" variant="ghost" />;
}

async function OnboardingContent() {
  const data = await loadOnboardingPage();
  if (data.state !== "ready") {
    return (
      <div className="min-h-0 flex-1">
        <ChatPageState state={data.state} message={data.state === "error" ? data.message : undefined} />
      </div>
    );
  }

  const { coverage, permissions } = data.context;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <Progress coverage={coverage} personalization={permissions.personalization} compact />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <Chat
          mode="onboarding"
          conversationId={data.conversation?.id ?? null}
          initialMessages={data.messages}
          aiConfigured={data.aiConfigured}
          autoStart
          placeholder="Tell it about your week in your own words…"
          emptyState={
            !data.aiConfigured ? (
              <div className="py-10 text-center">
                <h1 className="text-lg font-semibold tracking-tight text-ink">Let&apos;s get to know your week</h1>
                <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
                  Setup is a short conversation with the assistant. It needs an API key on the server first. You
                  can skip for now and come back later.
                </p>
              </div>
            ) : null
          }
        />
      </main>

      <Progress coverage={coverage} personalization={permissions.personalization} />
    </div>
  );
}

function Progress({
  coverage,
  personalization,
  compact = false,
}: {
  coverage: OnboardingCoverage;
  personalization: boolean;
  compact?: boolean;
}) {
  if (compact) {
    // Small screens: a slim progress strip above the conversation.
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 lg:hidden">
        <div className="flex flex-1 gap-1" aria-hidden>
          {coverage.topics.map((t) => (
            <span key={t.id} className={cn("h-1 flex-1 rounded-full", t.covered ? "bg-accent" : "bg-surface-2")} />
          ))}
        </div>
        <span className="text-[12px] tabular-nums text-ink-3">
          {coverage.coveredCount} of {coverage.total} topics
        </span>
        <FinishButton label={coverage.complete ? "Finish" : "Done for now"} variant={coverage.complete ? "primary" : "secondary"} />
      </div>
    );
  }

  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border p-6 lg:flex" aria-label="Setup progress">
      <div>
        <p className="text-[13px] font-semibold text-ink">What we&apos;ll cover</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          No forms. Answer in your own words and skip anything you like. Topics check off as you save what the
          assistant noticed.
        </p>
      </div>

      <ol className="space-y-2.5">
        {coverage.topics.map((t, i) => (
          <li key={t.id} className="flex items-center gap-3">
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums transition-colors",
                t.covered ? "bg-accent text-on-accent" : "border border-border-strong text-ink-3",
              )}
            >
              {t.covered ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("text-[13px]", t.covered ? "font-medium text-ink" : "text-ink-2")}>{t.label}</span>
          </li>
        ))}
      </ol>

      <div className="space-y-2">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${(coverage.coveredCount / coverage.total) * 100}%` }}
          />
        </div>
        <p className="text-[12px] text-ink-3">
          {coverage.coveredCount} of {coverage.total} topics have something saved
        </p>
      </div>

      <FinishButton
        label={coverage.complete ? "Finish setup" : "I'm done for now"}
        variant={coverage.complete ? "primary" : "secondary"}
      />

      <div className="mt-auto rounded-xl bg-surface-2 p-3.5">
        <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <ShieldCheck className="size-4 text-success" /> You stay in control
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          Nothing is saved until you tap Save. Review or edit everything later in{" "}
          <Link href={CONTEXT_REVIEW_HREF} className="font-medium text-accent-ink hover:underline">
            What Whitespace knows
          </Link>
          .
          {!personalization && " Personalization is off, so saved facts won't be used in replies until you turn it on."}
        </p>
      </div>
    </aside>
  );
}
