import { Badge } from "@/components/ui";
import { ContextPanel } from "@/features/assistant/context-panel";
import { Conversation } from "@/features/assistant/conversation";
import { ConversationHistory } from "@/features/assistant/history";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "AI Assistant" };

export default function AssistantPage() {
  return (
    <div data-fullbleed>
      <div className="flex h-[calc(100dvh-3.5rem-4rem-env(safe-area-inset-bottom))] overflow-hidden bg-surface lg:h-dvh">
        <ConversationHistory />
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-border px-4 py-3.5 sm:px-8">
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight text-ink">Chem test study plan</h1>
              <p className="text-[12px] text-ink-3">Planning conversation</p>
            </div>
            <Badge>Not connected yet</Badge>
          </header>
          <div className="min-h-0 flex-1">
            <Conversation />
          </div>
        </section>
        <ContextPanel />
      </div>
    </div>
  );
}
