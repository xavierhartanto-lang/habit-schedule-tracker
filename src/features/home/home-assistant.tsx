import { Skeleton } from "@/components/ui";
import { buttonClasses } from "@/components/ui/button";
import { Chat } from "@/features/assistant/chat";
import { formatDateKey } from "@/lib/scheduling/zoned";
import { ArrowUpRight, Database, LogIn, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { loadHomeAssistant } from "./assistant-data";
import { shownIds } from "./proactive";
import type { WeekSummary } from "./week-summary";

/**
 * The center of Home. Not a panel: the page itself is the assistant.
 * Greeting and the week in one line, then the daily brief, what needs
 * attention, the conversation, and a composer pinned to the bottom.
 * Render inside <Suspense>.
 */

const GHOST_LINK = buttonClasses("ghost", "sm", "h-7 px-2 text-[12px] text-ink-3");

function Header({
  date,
  greeting,
  week,
  actions,
}: {
  date: string | null;
  greeting: string;
  week?: WeekSummary;
  actions?: ReactNode;
}) {
  return (
    <header className="animate-fade-up">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="text-[13px] tabular-nums text-ink-3">{date}</p>
        {actions && <div className="-mr-2 flex items-center gap-0.5">{actions}</div>}
      </div>
      <h1 className="mt-1 text-[28px] font-semibold leading-[1.15] tracking-[-0.022em] text-ink sm:text-[32px]">
        {greeting}
      </h1>
      {week && <WeekLine week={week} />}
    </header>
  );
}

/** Three plain facts about the next seven days, inline under the greeting. */
function WeekLine({ week }: { week: WeekSummary }) {
  const facts: { value: string; label: string }[] = [
    { value: String(week.commitments), label: week.commitments === 1 ? "commitment" : "commitments" },
    { value: String(week.deadlines), label: week.deadlines === 1 ? "deadline" : "deadlines" },
    week.busiestDay
      ? { value: formatDateKey(week.busiestDay, { weekday: "short" }), label: "busiest" }
      : { value: String(week.openDays), label: week.openDays === 1 ? "open day" : "open days" },
  ];
  return (
    <dl aria-label="Next 7 days" className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-ink-3">
      <dt className="text-ink-3">Next 7 days</dt>
      {facts.map((f) => (
        <dd key={f.label} className="flex items-baseline gap-1">
          <span className="font-medium tabular-nums text-ink">{f.value}</span>
          {f.label}
        </dd>
      ))}
    </dl>
  );
}

export function HomeAssistantSkeleton() {
  return (
    <div className="space-y-10">
      <div>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-8 w-72" />
        <Skeleton className="mt-4 h-4 w-60" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-4 w-4/5 max-w-lg" />
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-8 w-28 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-14 rounded-2xl" />
    </div>
  );
}

function Blocked({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-border bg-surface px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-3">{icon}</span>
      <h2 className="mt-4 text-[15px] font-medium text-ink">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export async function HomeAssistant({ fresh }: { fresh: boolean }) {
  const data = await loadHomeAssistant();

  if (data.state === "preview") {
    return (
      <div className="space-y-8">
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
      <div className="space-y-8">
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
      <div className="space-y-8">
        <Header date={null} greeting={data.greeting} />
        <Blocked
          icon={<Sparkles className="size-5" />}
          title="Couldn't load your schedule"
          body="The assistant needs your calendar to open the conversation. Refresh to try again."
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
    // With suggestions below, keep the row short so the conversation stays calm.
    .slice(0, Math.max(0, (proactive.nudges.length ? 3 : 4) - actionChips.length));

  return (
    <div className="flex flex-col gap-9">
      <Header
        date={formatDateKey(data.todayKey, { weekday: "long", month: "long", day: "numeric" })}
        greeting={data.opening.greeting}
        week={data.week}
        actions={
          <>
            {resumed && (
              <Link href="/?new=1" className={GHOST_LINK}>
                <Plus className="size-3.5" /> New chat
              </Link>
            )}
            <Link href={conversationId ? `/assistant?c=${conversationId}` : "/assistant"} className={GHOST_LINK}>
              Full view <ArrowUpRight className="size-3.5" />
            </Link>
          </>
        }
      />
      <section aria-label="Assistant" className="min-w-0">
        <Chat
          key={conversationId ?? "home"}
          mode="assistant"
          variant="embedded"
          conversationId={conversationId}
          initialMessages={resumed ? data.messages : []}
          aiConfigured={data.aiConfigured}
          opening={resumed ? null : (proactive.opening?.message ?? data.opening.message)}
          openingChips={openingChips}
          starters={starters}
          nudges={resumed ? proactive.resumeNudges : proactive.nudges}
          shownRecommendationIds={shownIds(proactive, resumed)}
          placeholder="Tell me what’s coming up…"
        />
      </section>
    </div>
  );
}
