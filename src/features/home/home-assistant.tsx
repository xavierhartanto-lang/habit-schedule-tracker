import { Skeleton } from "@/components/ui";
import { buttonClasses } from "@/components/ui/button";
import { Chat } from "@/features/assistant/chat";
import { ArrowUpRight, Database, LogIn, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { loadHomeAssistant } from "./assistant-data";
import { shownIds } from "./proactive";

/**
 * The center of Home: a greeting and a live conversation with the
 * assistant, opened with a line built from the user's real schedule.
 * Render inside <Suspense>.
 */

const PANEL = "flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card";
const PANEL_HEIGHT = "h-[min(600px,calc(100dvh-14rem))] min-h-[440px]";

function Title({ greeting, sub }: { greeting: string; sub: string }) {
  return (
    <div className="animate-fade-up">
      <h1 className="text-[26px] font-semibold tracking-tight text-ink sm:text-[30px]">{greeting}</h1>
      <p className="mt-1 text-[15px] text-ink-2">{sub}</p>
    </div>
  );
}

function PanelBar({ resumed, conversationId }: { resumed: boolean; conversationId: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 sm:px-5">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent">
          <Sparkles className="size-3.5" />
        </span>
        {resumed ? "Picking up where you left off" : "Your assistant"}
      </p>
      <div className="flex items-center gap-1">
        {resumed && (
          <Link href="/?new=1" className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px]")}>
            <Plus className="size-3.5" /> New
          </Link>
        )}
        <Link
          href={conversationId ? `/assistant?c=${conversationId}` : "/assistant"}
          className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px]")}
        >
          Full view <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

export function HomeAssistantSkeleton() {
  return (
    <div className="space-y-5">
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-48" />
      </div>
      <div className={`${PANEL} ${PANEL_HEIGHT}`}>
        <div className="border-b border-border px-5 py-3">
          <Skeleton className="h-5 w-36" />
        </div>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-8 w-28 rounded-full" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        </div>
        <div className="border-t border-border p-4">
          <Skeleton className="h-12 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function Blocked({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className={`${PANEL} items-center justify-center px-6 py-14 text-center`}>
      <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-3">{icon}</span>
      <h2 className="mt-4 text-[15px] font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export async function HomeAssistant({ fresh }: { fresh: boolean }) {
  const data = await loadHomeAssistant();

  if (data.state === "preview") {
    return (
      <div className="space-y-5">
        <Title greeting={data.greeting} sub="Preview mode" />
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
        <Title greeting={data.greeting} sub="Sign in to plan your week." />
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
        <Title greeting={data.greeting} sub="Something didn't load." />
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
  const sub = data.aiConfigured
    ? "Tell me what's going on. I'll keep your plan in order."
    : "Here's your day. The assistant isn't set up yet.";

  const { proactive } = data;
  const openingChips = resumed ? [] : (proactive.opening?.chips ?? []);
  // Proactive buttons come first; the general starters fill up to four.
  const starters = data.opening.starters.slice(0, Math.max(0, 4 - openingChips.filter((c) => c.act.kind !== "dismiss").length));

  return (
    <div className="space-y-5">
      <Title greeting={data.opening.greeting} sub={sub} />
      <section aria-label="Assistant" className={`${PANEL} ${PANEL_HEIGHT}`}>
        <PanelBar resumed={resumed} conversationId={conversationId} />
        <div className="min-h-0 flex-1">
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
        </div>
      </section>
    </div>
  );
}
