import { Skeleton } from "@/components/ui";
import { buttonClasses } from "@/components/ui/button";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { Database, LogIn, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { loadHomeAssistant } from "./assistant-data";
import { AssistantOverlay, AssistantTrigger } from "./assistant-overlay";
import { shownIds } from "./proactive";
import { quoteForDay } from "./quotes";
import { Weather } from "./weather";

/**
 * The top of Home: date and weather, the greeting, the quote of the day,
 * and a discreet way into the assistant. The conversation itself lives in
 * a sheet (AssistantOverlay), not on the page. Render inside <Suspense>.
 */

function Header({ date, greeting, aside }: { date: ReactNode; greeting: string; aside?: ReactNode }) {
  return (
    <header className="flex animate-fade-up items-start justify-between gap-4 px-1 pt-1 sm:pt-3">
      <div className="min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-medium text-ink-3">{date}</div>
        <h1 className="mt-1.5 text-[32px] font-bold leading-[1.05] tracking-[-0.035em] text-ink text-balance sm:text-[44px]">{greeting}</h1>
      </div>
      {aside}
    </header>
  );
}

function QuoteOfTheDay({ todayKey }: { todayKey: string }) {
  const q = quoteForDay(todayKey);
  return (
    <figure className="max-w-[56ch] animate-fade-up px-1 [animation-delay:60ms]">
      <blockquote className="font-serif text-[15.5px] italic leading-relaxed text-ink-2 text-pretty sm:text-[16.5px]">
        <span aria-hidden className="mr-0.5 text-accent/70">“</span>
        {q.text}
        <span aria-hidden className="ml-0.5 text-accent/70">”</span>
      </blockquote>
      {q.author && <figcaption className="mt-1 text-[12px] font-medium tracking-wide text-ink-3">{q.author}</figcaption>}
    </figure>
  );
}

export function HomeTopSkeleton() {
  return (
    <div className="space-y-5 px-1 pt-1 sm:pt-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-3 h-10 w-72 max-w-full" />
        </div>
        <Skeleton className="size-12 rounded-full" />
      </div>
      <Skeleton className="h-5 w-80 max-w-full" />
    </div>
  );
}

function Blocked({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-[22px] border border-border/70 bg-surface px-6 py-14 text-center shadow-card dark:border-border">
      <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-3">{icon}</span>
      <h2 className="mt-4 text-[15px] font-medium text-ink">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export async function HomeTop({ fresh }: { fresh: boolean }) {
  const data = await loadHomeAssistant();

  if (data.state === "preview") {
    return (
      <div className="space-y-5">
        <Header date="Preview mode" greeting={data.greeting} />
        <Blocked
          icon={<Database className="size-5" />}
          title="Connect Supabase to start planning"
          body="Your assistant needs a place to keep your schedule and conversations. Add your Supabase URL and key to the environment, then restart."
        />
      </div>
    );
  }
  if (data.state === "signed-out") {
    return (
      <div className="space-y-5">
        <Header date={null} greeting={data.greeting} />
        <Blocked
          icon={<LogIn className="size-5" />}
          title="Sign in to continue"
          body="Your schedule and conversations are private to your account."
          action={
            <Link href="/login" className={buttonClasses("primary", "sm")}>
              Sign in
            </Link>
          }
        />
      </div>
    );
  }
  if (data.state === "error") {
    return (
      <div className="space-y-5">
        <Header date={null} greeting={data.greeting} />
        <Blocked
          icon={<Sparkles className="size-5" />}
          title="Couldn't load your schedule"
          body="Whitespace needs your calendar to open your day. Refresh to try again."
        />
      </div>
    );
  }

  const resumed = !fresh && data.messages.length > 0;
  const conversationId = resumed ? data.conversationId : null;

  const { proactive } = data;
  const openingChips = resumed ? [] : (proactive.opening?.chips ?? []);
  // Proactive buttons come first; the general starters fill up to four.
  // When Whitespace leads with its own suggestion, the Phase 4 opening's topic
  // starter (and a duplicate "Plan my day") would compete with it, so only
  // the general ones stay.
  const actionChips = openingChips.filter((c) => c.act.kind !== "dismiss");
  const general = proactive.opening && !resumed ? data.opening.generalStarters : data.opening.starters;
  const starters = general
    .filter((s) => !(s.checkIn === "daily" && actionChips.some((c) => c.act.kind === "daily_plan")))
    .filter((s) => !actionChips.some((c) => c.label === s.label))
    .slice(0, Math.max(0, (proactive.nudges.length ? 3 : 4) - actionChips.length));
  const nudges = resumed ? proactive.resumeNudges : proactive.nudges;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Header
        date={
          <>
            <span className="tabular-nums">{formatDateKey(data.todayKey, { weekday: "long", month: "long", day: "numeric" })}</span>
            <Weather timeZone={data.timeZone} />
          </>
        }
        greeting={data.opening.greeting}
        aside={<AssistantTrigger waiting={nudges.length > 0 || Boolean(proactive.opening && !resumed)} />}
      />
      <QuoteOfTheDay todayKey={data.todayKey} />
      <AssistantOverlay
        resumed={resumed}
        autoOpen={fresh}
        chat={{
          conversationId,
          initialMessages: resumed ? data.messages : [],
          aiConfigured: data.aiConfigured,
          opening: resumed ? null : (proactive.opening?.message ?? data.opening.message),
          openingChips,
          starters,
          nudges,
          shownRecommendationIds: shownIds(proactive, resumed),
          placeholder: "Tell me what’s coming up…",
        }}
      />
    </div>
  );
}
