"use client";

import { SampleDataBadge } from "@/components/ui";
import { SAMPLE_CONVERSATION, SUGGESTED_PROMPTS } from "@/lib/placeholder";
import { ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AssistantMessage, SuggestedBlocks, SystemNotice, ThinkingState, UserMessage } from "./messages";

type LocalTurn =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "pending" }
  | { id: string; kind: "unavailable" };

/**
 * Conversation layout. The assistant is NOT connected in Phase 1:
 * sending a message shows a brief pending state, then an honest notice.
 * Nothing leaves the browser.
 */
export function Conversation() {
  const [turns, setTurns] = useState<LocalTurn[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const send = (text: string) => {
    const value = text.trim();
    if (!value) return;
    const id = String(Date.now());
    setTurns((t) => [...t, { id: `${id}-u`, kind: "user", text: value }, { id: `${id}-p`, kind: "pending" }]);
    setDraft("");
    timer.current = window.setTimeout(() => {
      setTurns((t) => t.map((x) => (x.id === `${id}-p` ? { id: `${id}-n`, kind: "unavailable" } : x)));
    }, 900);
  };

  const busy = turns.some((t) => t.kind === "pending");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="flex items-center justify-center gap-2">
          <span className="h-px flex-1 bg-border" />
          <SampleDataBadge />
          <span className="text-[11px] text-ink-3">Example conversation</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {SAMPLE_CONVERSATION.map((m) =>
          m.role === "user" ? (
            <UserMessage key={m.id}>{m.text}</UserMessage>
          ) : (
            <AssistantMessage key={m.id} footer={"suggestions" in m && <SuggestedBlocks items={m.suggestions} />}>
              {m.text}
            </AssistantMessage>
          ),
        )}

        {turns.length > 0 && (
          <div className="flex items-center gap-2 pt-2">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-ink-3">Your messages</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        )}

        {turns.map((t) =>
          t.kind === "user" ? (
            <UserMessage key={t.id}>{t.text}</UserMessage>
          ) : t.kind === "pending" ? (
            <ThinkingState key={t.id} />
          ) : (
            <SystemNotice key={t.id} tone="warn">
              The assistant isn&apos;t connected yet, so there&apos;s no reply. Your message stayed on this device.
            </SystemNotice>
          ),
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border bg-surface/80 px-4 pb-4 pt-3 backdrop-blur sm:px-8">
        {turns.length === 0 && (
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
            {SUGGESTED_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => setDraft(p)}
                className="shrink-0 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:text-ink"
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
          className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-card transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15"
        >
          <label htmlFor="assistant-input" className="sr-only">Message</label>
          <textarea
            id="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
            rows={1}
            placeholder="Ask about your week, a deadline, or a new commitment…"
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            aria-label="Send"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-hover disabled:bg-surface-2 disabled:text-ink-3"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
        <p className="mt-2 text-center text-[11px] text-ink-3">
          Preview only. The assistant will be connected in a later phase.
        </p>
      </div>
    </div>
  );
}
