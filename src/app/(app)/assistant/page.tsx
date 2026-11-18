import { Badge } from "@/components/ui";
import { Chat } from "@/features/assistant/chat";
import { ContextPanel } from "@/features/assistant/context-panel";
import { ConversationHistory, ConversationSwitcher } from "@/features/assistant/history";
import { ChatPageState, ChatSkeleton } from "@/features/assistant/page-states";
import { loadAssistantPage } from "@/features/assistant/server/load";
import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "AI Assistant" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUGGESTIONS = [
  "What does my week look like?",
  "Help me fit in time for a new club",
  "I have a big test Friday. Where should I study?",
  "I've changed my practice schedule",
];

const FRAME = "flex h-[calc(100dvh-3.5rem-4rem-env(safe-area-inset-bottom))] overflow-hidden bg-surface lg:h-dvh";

export default function AssistantPage(props: PageProps<"/assistant">) {
  return (
    <div data-fullbleed>
      <Suspense
        fallback={
          <div className={FRAME}>
            <section className="flex min-w-0 flex-1 flex-col">
              <Header title="AI Assistant" />
              <ChatSkeleton />
            </section>
          </div>
        }
      >
        <AssistantContent searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

function Header({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-8">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="text-[12px] text-ink-3">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}

async function AssistantContent({ searchParams }: { searchParams: PageProps<"/assistant">["searchParams"] }) {
  const { c } = await searchParams;
  const requested = typeof c === "string" ? c : null;
  if (requested !== null && !UUID_RE.test(requested)) {
    return (
      <div className={FRAME}>
        <ChatPageState state="not_found" />
      </div>
    );
  }
  const conversationId = requested;
  const data = await loadAssistantPage(conversationId);

  if (data.state !== "ready") {
    return (
      <div className={FRAME}>
        <ChatPageState state={data.state} message={data.state === "error" ? data.message : undefined} />
      </div>
    );
  }

  const { conversation, context } = data;
  return (
    <div className={FRAME}>
      <ConversationHistory conversations={data.conversations} activeId={conversation?.id ?? null} />
      <section className="flex min-w-0 flex-1 flex-col">
        <Header
          title={conversation?.title ?? "New conversation"}
          subtitle={
            context.permissions.personalization
              ? "Uses what Whitespace knows about you"
              : "Personalization is off"
          }
          right={
            <div className="flex items-center gap-2">
              {!data.aiConfigured && <Badge>Not set up</Badge>}
              <ConversationSwitcher conversations={data.conversations} activeId={conversation?.id ?? null} />
            </div>
          }
        />
        <div className="min-h-0 flex-1">
          <Chat
            key={conversation?.id ?? "new"}
            mode="assistant"
            conversationId={conversation?.id ?? null}
            initialMessages={data.messages}
            aiConfigured={data.aiConfigured}
            suggestions={SUGGESTIONS}
            placeholder="Ask about your week, a deadline, or a new commitment…"
            emptyState={
              <div className="flex flex-col items-center py-10 text-center">
                <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Sparkles className="size-5" />
                </span>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">What&apos;s on your mind?</h2>
                <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">
                  Think through your week, a deadline, or something new. If you mention a change, Whitespace will
                  offer to remember it. You decide what gets saved.
                </p>
              </div>
            }
          />
        </div>
      </section>
      <ContextPanel
        coverage={context.coverage}
        factCount={context.known.length}
        personalization={context.permissions.personalization}
        memory={context.permissions.memory}
        onboarded={context.onboardedAt !== null}
      />
    </div>
  );
}
