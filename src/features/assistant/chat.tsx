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
import { PlanCard, type PlanCardActions } from "./plan-card";
import { approvePlanItems, editPlanItem, rejectPlanItems, requestAlternatives, undoPlanItem } from "./plan-actions";
import { CHAT_MESSAGE_MAX, type ChatMessage, type ChatProactive, type ClientAiError, type Proposal } from "./types";
import { ChipRow, NudgeList } from "./proactive-nudges";
import { dismissRecommendation, markRecommendationsShown } from "@/features/proactive/actions";
import type { Nudge, ProactiveChip } from "@/features/home/proactive";

const PLAN_ACTIONS: PlanCardActions = {
  approve: approvePlanItems,
  reject: rejectPlanItems,
  edit: editPlanItem,
  alternatives: requestAlternatives,
  undo: undoPlanItem,
};

/**
 * The live conversation: persisted history, streaming replies, proposal
 * cards, and honest error and configuration states.
 */

type Mode = "onboarding" | "assistant";

/** A one-tap conversation starter. With `checkIn`, the assistant opens a planning check-in. */
export type ChatStarter = { label: string; prompt: string; checkIn?: "daily" | "weekly" };

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
  /**
   * "embedded" (Home): starters send right away and sit under the opening
   * line, and the URL is left alone. "page" (/assistant): the full screen.
   */
  variant?: "page" | "embedded";
  /** Opening line shown before the first message, built from real data (never an LLM guess). */
  opening?: string | null;
  starters?: ChatStarter[];
  /** Phase 5: buttons under the opening line (daily plan, a recommendation's actions). Work without the AI. */
  openingChips?: ProactiveChip[];
  /** Phase 5: gentle suggestions. Under the opening line, or after a resumed conversation. */
  nudges?: Nudge[];
  /** Recommendations this view shows, so the engine starts their cooldown. */
  shownRecommendationIds?: string[];
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
  variant = "page",
  opening = null,
  starters = [],
  openingChips = [],
  nudges = [],
  shownRecommendationIds = [],
}: Props) {
  const embedded = variant === "embedded";
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
  // Keep showing the opening line once the conversation it started is under way.
  const [showOpening, setShowOpening] = useState(() => Boolean(opening) && initialMessages.length === 0);
  const stickToBottom = useRef(true);
  // Suggestions the user acted on or put off in this view.
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [resumeAt] = useState(() => initialMessages.length - 1);

  // Keep the newest content in view unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, failure, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Start the cooldown for what Home showed, once per page view.
  const shownKey = shownRecommendationIds.join(",");
  useEffect(() => {
    if (!shownKey) return;
    void markRecommendationsShown({ ids: shownKey.split(",") }).catch(() => undefined);
  }, [shownKey]);

  const run = useCallback(
    async (request: {
      message?: string;
      retry?: boolean;
      checkIn?: "daily" | "weekly";
      proactive?: ChatProactive;
      /** The suggestion the user is answering, saved as the assistant's line before their message. */
      nudge?: string;
    }) => {
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
            plan: null,
            clarify: null,
          },
        ]);
      }

      let createdConversation = false;
      let userSaved = !request.message;
      let gotReply = false;

      // The opening line is shown before the conversation exists. Send it with
      // the first message so the assistant knows what it "said".
      const sendOpening = !conversationId && opening && request.message ? opening : undefined;

      for await (const event of streamChat(
        {
          mode,
          conversationId,
          message: request.message,
          retry: request.retry,
          checkIn: request.checkIn,
          opening: sendOpening,
          proactive: request.proactive,
          nudge: request.nudge,
        },
        controller.signal,
      )) {
        switch (event.type) {
          case "plan":
            setMessages((m) => m.map((x) => (x.id === event.messageId ? { ...x, plan: event.plan } : x)));
            break;
          case "clarify":
            setMessages((m) => m.map((x) => (x.id === event.messageId ? { ...x, clarify: event.clarify } : x)));
            break;
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
              if (mode === "assistant" && !embedded) {
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
    [busy, conversationId, mode, router, embedded, opening],
  );

  // Onboarding: let the assistant say hello first.
  useEffect(() => {
    if (!autoStart || !aiConfigured || started.current || initialMessages.length > 0) return;
    started.current = true;
    void run({});
  }, [autoStart, aiConfigured, initialMessages.length, run]);

  const startWith = (s: ChatStarter) => {
    if (busy || !aiConfigured) return;
    if (!embedded && !s.checkIn) {
      setDraft(s.prompt);
      inputRef.current?.focus();
      return;
    }
    // A check-in opens a fresh planning conversation where the assistant speaks first.
    if (s.checkIn && !conversationId) {
      // The check-in opens with its own message from the assistant, so the Home line steps aside.
      setShowOpening(false);
      void run({ checkIn: s.checkIn });
    }
    else void run({ message: s.prompt });
  };

  /** A tap on a proactive button. Changes always come back as an approval card. */
  const act = (chip: ProactiveChip, nudge: Nudge | null) => {
    if (busy) return;
    const done = (id: string) => setHandled((h) => new Set(h).add(id));
    const a = chip.act;
    switch (a.kind) {
      case "dismiss":
        done(a.id);
        void dismissRecommendation({ id: a.id, reason: "not_now" }).catch(() => undefined);
        return;
      case "ask":
        if (!aiConfigured) return;
        if (nudge) done(nudge.id);
        void run({ message: a.prompt, nudge: nudge?.message });
        return;
      case "recommendation":
        done(a.id);
        void run({ message: chip.label, proactive: { kind: "recommendation", id: a.id, actionId: a.actionId }, nudge: nudge?.message });
        return;
      case "daily_plan":
        void run({ message: chip.label, proactive: { kind: "daily_plan" } });
        return;
    }
  };
  const visibleNudges = nudges.filter((n) => !handled.has(n.id));
  const openingRecHandled = openingChips.some((c) => c.act.kind === "dismiss" && handled.has(c.act.id));

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
  const lastUserId = messages.findLast((m) => m.role === "user")?.id ?? null;
  // A saved message with no reply (e.g. the page was reloaded after an error).
  const unanswered = lastIsUser && !busy && !failure && !messages.at(-1)!.id.startsWith("pending-");
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
        <div className={cn("mx-auto w-full max-w-3xl space-y-6 px-4 py-6", embedded ? "sm:px-6" : "sm:px-8")}>
          {empty && !showOpening && emptyState}

          {showOpening && opening && (
            <div className="space-y-3">
              <AssistantMessage>
                <p>{opening}</p>
              </AssistantMessage>
              {empty && !openingRecHandled && openingChips.length > 0 && (
                <ChipRow chips={openingChips} onAct={(c) => act(c, null)} disabled={busy} className="pl-10" />
              )}
              {empty && aiConfigured && starters.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pl-10">
                  {starters.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => startWith(s)}
                      className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent-ink"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              {!initialMessages.length && visibleNudges.length > 0 && (
                <div className="pl-10 pt-1">
                  <NudgeList nudges={visibleNudges} lead="Also worth a look" onAct={(n, c) => act(c, n)} disabled={busy} />
                </div>
              )}
            </div>
          )}

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
                {m.role === "assistant" && m.plan && (
                  <div className="sm:pl-10">
                    <PlanCard key={`${m.plan.id}:${m.plan.version}`} plan={m.plan} actions={PLAN_ACTIONS} disabled={busy} />
                  </div>
                )}
                {m.role === "assistant" && m.clarify && i === messages.length - 1 && !busy && aiConfigured && m.clarify.choices.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-10">
                    {m.clarify.choices.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => void run({ message: c })}
                        className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent-ink"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                )}
                {proposalSource && (
                  <ProposalGroup
                    messageId={proposalSource.id}
                    proposals={proposalSource.proposals}
                    clarifications={proposalSource.id === lastUserId ? proposalSource.clarifications : []}
                    extractionError={proposalSource.extractionError}
                    onProposalsChange={onProposalsChange}
                    onAnswer={answer}
                  />
                )}
                {i === resumeAt && visibleNudges.length > 0 && (
                  <AssistantMessage>
                    <NudgeList
                      nudges={visibleNudges}
                      lead={visibleNudges.length > 1 ? "A couple of things I noticed" : "Something I noticed"}
                      onAct={(n, c) => act(c, n)}
                      disabled={busy}
                    />
                  </AssistantMessage>
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

          {unanswered && aiConfigured && (
            <SystemNotice
              action={
                <button
                  type="button"
                  onClick={() => void run({ retry: true })}
                  className={buttonClasses("secondary", "sm", "-my-1 h-7 px-2.5 text-[12px]")}
                >
                  <RotateCcw className="size-3.5" /> Get a reply
                </button>
              }
            >
              This message doesn&apos;t have a reply yet.
            </SystemNotice>
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
        <div className={cn("mx-auto w-full max-w-3xl px-4 pb-4 pt-3", embedded ? "sm:px-6" : "sm:px-8")}>
          {!aiConfigured ? (
            <NotConfigured />
          ) : (
            <>
              {empty && !showOpening && starters.length > 0 && (
                <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
                  {starters.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => startWith(s)}
                      className="shrink-0 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:text-ink"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              {empty && !showOpening && suggestions.length > 0 && (
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
                  className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-3 composer-input"
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
                  : "Calendar changes always wait for your approval."}
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
