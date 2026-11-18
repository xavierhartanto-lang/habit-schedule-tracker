"use client";

import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { ArrowUp, KeyRound, RotateCcw, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AssistantMessage, SystemNotice, ThinkingState, UserMessage } from "./messages";
import { ProposalGroup } from "./proposal-cards";
import { RichText } from "./rich-text";
import { streamChat } from "./stream";
import { CHAT_MESSAGE_MAX, type ChatMessage, type ClientAiError, type Proposal } from "./types";

/**
 * The live conversation: persisted history, streaming replies, proposal
 * cards, and honest error and configuration states.
 */

type Mode = "onboarding" | "assistant";

type Props = {
  mode: Mode;
  conversationId: string | null;
  initialMessages: ChatMessage[];
  aiConfigured: boolean;
  /** Onboarding: the assistant opens the conversation when it is empty. */
  autoStart?: boolean;
  /** Shown above the composer when there are no messages yet. */
  emptyState?: ReactNode;
  suggestions?: string[];
  placeholder?: string;
};

type Failure = { error: ClientAiError; canRetry: boolean };

export function Chat({
  mode,
  conversationId: initialConversationId,
  initialMessages,
  aiConfigured,
  autoStart = false,
  emptyState,
  suggestions = [],
  placeholder = "Message Whitespace…",
}: Props) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const started = useRef(false);
  const stickToBottom = useRef(true);

  // Keep the newest content in view unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, failure, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (request: { message?: string; retry?: boolean }) => {
      if (busy) return;
      setBusy(true);
      setFailure(null);
      stickToBottom.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      const tempId = request.message ? `pending-${Date.now()}` : null;
      if (request.message && tempId) {
        setMessages((m) => [
          ...m,
          {
            id: tempId,
            role: "user",
            content: request.message!,
            createdAt: new Date().toISOString(),
            proposals: [],
            clarifications: [],
            extractionError: null,
          },
        ]);
      }

      let createdConversation = false;
      let userSaved = !request.message;
      let gotReply = false;

      for await (const event of streamChat(
        { mode, conversationId, message: request.message, retry: request.retry },
        controller.signal,
      )) {
        switch (event.type) {
          case "http_error":
            if (tempId && !userSaved) {
              setMessages((m) => m.filter((x) => x.id !== tempId));
              setDraft((d) => d || request.message || "");
            }
            setFailure({ error: event.error, canRetry: false });
            break;
          case "conversation":
            if (!conversationId) {
              createdConversation = true;
              setConversationId(event.conversation.id);
              if (mode === "assistant") {
                window.history.replaceState(null, "", `/assistant?c=${event.conversation.id}`);
              }
            }
            break;
          case "user_message":
            userSaved = true;
            setMessages((m) => m.map((x) => (x.id === tempId ? event.message : x)));
            break;
          case "delta":
            setStreaming((s) => (s ?? "") + event.text);
            break;
          case "assistant_message":
            gotReply = true;
            setStreaming(null);
            setMessages((m) => [...m, event.message]);
            break;
          case "proposals":
            setMessages((m) =>
              m.map((x) =>
                x.id === event.messageId
                  ? {
                      ...x,
                      proposals: event.proposals,
                      clarifications: event.clarifications,
                      extractionError: event.extractionError,
                    }
                  : x,
              ),
            );
            break;
          case "error":
            setStreaming(null);
            setFailure({ error: event.error, canRetry: event.error.retryable || event.error.code === "unknown" });
            break;
          case "done":
            break;
        }
      }

      setStreaming(null);
      setBusy(false);
      abortRef.current = null;
      if (controller.signal.aborted && !gotReply) {
        setFailure({
          error: { code: "aborted", message: "Stopped. Your message is saved.", retryable: true },
          canRetry: userSaved && Boolean(request.message || request.retry),
        });
      }
      // Pick up the new conversation in the history list.
      if (createdConversation) router.refresh();
    },
    [busy, conversationId, mode, router],
  );

  // Onboarding: let the assistant say hello first.
  useEffect(() => {
    if (!autoStart || !aiConfigured || started.current || initialMessages.length > 0) return;
    started.current = true;
    void run({});
  }, [autoStart, aiConfigured, initialMessages.length, run]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy || !aiConfigured || text.length > CHAT_MESSAGE_MAX) return;
    setDraft("");
    setAnswering(null);
    if (inputRef.current) inputRef.current.style.height = "auto";
    void run({ message: text });
  };

  const onProposalsChange = useCallback((messageId: string, proposals: Proposal[]) => {
    setMessages((m) => m.map((x) => (x.id === messageId ? { ...x, proposals } : x)));
  }, []);

  const [answering, setAnswering] = useState<string | null>(null);
  const answer = useCallback((question: string) => {
    setAnswering(question);
    inputRef.current?.focus();
  }, []);

  const lastIsUser = messages.at(-1)?.role === "user";
  const empty = messages.length === 0 && !busy;
  const tooLong = draft.length > CHAT_MESSAGE_MAX;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
        aria-live="polite"
        aria-busy={busy}
      >
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8">
          {empty && emptyState}

          {messages.map((m, i) => {
            const next = messages[i + 1];
            // Proposals render after the reply to the message they came from.
            const proposalSource =
              m.role === "assistant" && messages[i - 1]?.role === "user"
                ? messages[i - 1]
                : m.role === "user" && (!next || next.role === "user") && !(i === messages.length - 1 && streaming !== null)
                  ? m
                  : null;
            return (
              <div key={m.id} className="space-y-3">
                {m.role === "user" ? (
                  <UserMessage pending={m.id.startsWith("pending-")}>{m.content}</UserMessage>
                ) : (
                  <AssistantMessage>
                    <RichText text={m.content} />
                  </AssistantMessage>
                )}
                {proposalSource && (
                  <ProposalGroup
                    messageId={proposalSource.id}
                    proposals={proposalSource.proposals}
                    clarifications={proposalSource.clarifications}
                    extractionError={proposalSource.extractionError}
                    onProposalsChange={onProposalsChange}
                    onAnswer={answer}
                  />
                )}
              </div>
            );
          })}

          {streaming !== null && streaming.length > 0 && (
            <AssistantMessage>
              <RichText text={streaming} />
            </AssistantMessage>
          )}
          {busy && !streaming && (
            <ThinkingState label={mode === "onboarding" && messages.length === 0 ? "Getting ready" : "Thinking"} />
          )}

          {failure && (
            <SystemNotice
              tone="warn"
              action={
                failure.canRetry && lastIsUser ? (
                  <button
                    type="button"
                    onClick={() => void run({ retry: true })}
                    className={buttonClasses("secondary", "sm", "-my-1 h-7 px-2.5 text-[12px]")}
                  >
                    <RotateCcw className="size-3.5" /> Retry
                  </button>
                ) : failure.canRetry && mode === "onboarding" && messages.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => void run({})}
                    className={buttonClasses("secondary", "sm", "-my-1 h-7 px-2.5 text-[12px]")}
                  >
                    <RotateCcw className="size-3.5" /> Try again
                  </button>
                ) : null
              }
            >
              {failure.error.message}
            </SystemNotice>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-3 sm:px-8">
          {!aiConfigured ? (
            <NotConfigured />
          ) : (
            <>
              {empty && suggestions.length > 0 && (
                <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
                  {suggestions.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setDraft(p);
                        inputRef.current?.focus();
                      }}
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
                  send();
                }}
                className={cn(
                  "flex items-end gap-2 rounded-2xl border bg-surface p-2 shadow-card transition-colors focus-within:ring-2 focus-within:ring-accent/15",
                  tooLong ? "border-danger/60" : "border-border focus-within:border-accent/50",
                )}
              >
                <label htmlFor={`${mode}-input`} className="sr-only">
                  Message
                </label>
                <textarea
                  ref={inputRef}
                  id={`${mode}-input`}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder={answering ?? placeholder}
                  className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
                />
                {busy ? (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    aria-label="Stop"
                    className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 transition-colors hover:text-ink"
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!draft.trim() || tooLong}
                    aria-label="Send"
                    className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-hover disabled:bg-surface-2 disabled:text-ink-3"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
              </form>
              <p className={cn("mt-2 text-center text-[11px]", tooLong ? "text-danger" : "text-ink-3")}>
                {tooLong
                  ? `That's ${draft.length.toLocaleString()} characters. Keep it under ${CHAT_MESSAGE_MAX.toLocaleString()}.`
                  : "Suggestions only save when you tap Save. Whitespace never changes your calendar on its own."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-dashed border-border-strong bg-surface-2/60 px-4 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-ink-3">
        <KeyRound className="size-4" />
      </span>
      <div className="text-[13px] leading-relaxed">
        <p className="font-medium text-ink">The assistant isn&apos;t set up yet</p>
        <p className="mt-0.5 text-ink-2">
          Add <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">ANTHROPIC_API_KEY</code> to the
          server environment and restart. Your saved conversations stay here in the meantime.
        </p>
      </div>
    </div>
  );
}
