"use client";

import { Chat } from "@/features/assistant/chat";
import { cn } from "@/lib/utils/cn";
import { ArrowUpRight, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { HOME_ACT_EVENT, HOME_OPEN_EVENT, openHomeAssistant, type HomeActDetail } from "./adaptive/home-bridge";

type ChatProps = Omit<ComponentProps<typeof Chat>, "variant" | "active" | "mode">;

const ICON_BUTTON =
  "grid size-9 place-items-center rounded-xl text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-surface-2 hover:text-ink active:scale-95 pointer-coarse:size-11";

/**
 * The assistant on Home, as a sheet over the page instead of a chat log on
 * it. Full screen on phones, a side panel from sm up. The conversation
 * mounts the first time the sheet opens and then stays mounted, so a
 * running reply or an approval card survives closing and reopening.
 *
 * Opens from the header's AI button, from "Plan my day", and from any
 * suggestion button on Home (HOME_ACT_EVENT), which then runs inside it.
 */
export function AssistantOverlay({
  chat,
  resumed,
  autoOpen = false,
}: {
  chat: ChatProps;
  /** True when Home picked up today's conversation. */
  resumed: boolean;
  /** Open on load, e.g. after "New chat" (/?new=1). */
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [mounted, setMounted] = useState(autoOpen);
  // An action that arrived before the conversation existed; replayed once it has mounted.
  const pending = useRef<HomeActDetail | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOpen = () => {
      setMounted(true);
      setOpen(true);
    };
    const onAct = (e: Event) => {
      const detail = (e as CustomEvent<HomeActDetail>).detail;
      if (!mounted) {
        pending.current = detail;
        setMounted(true);
      }
      // A "not now" needs no sheet: the chat records it in the background.
      if (detail.chip.act.kind !== "dismiss") setOpen(true);
    };
    window.addEventListener(HOME_OPEN_EVENT, onOpen);
    window.addEventListener(HOME_ACT_EVENT, onAct);
    return () => {
      window.removeEventListener(HOME_OPEN_EVENT, onOpen);
      window.removeEventListener(HOME_ACT_EVENT, onAct);
    };
  }, [mounted]);

  // The chat's own listener is registered by now (child effects run first): hand it the action.
  useEffect(() => {
    if (!mounted || !pending.current) return;
    // Next tick, so a dev-mode effect re-run can't abort the reply it starts.
    const id = window.setTimeout(() => {
      const detail = pending.current;
      pending.current = null;
      if (detail) window.dispatchEvent(new CustomEvent<HomeActDetail>(HOME_ACT_EVENT, { detail }));
    }, 0);
    return () => window.clearTimeout(id);
  }, [mounted]);

  // Escape closes; the page behind doesn't scroll; focus returns to where it was.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // On a touch screen, focusing the composer would throw up the keyboard over the briefing.
    if (window.matchMedia("(pointer: fine)").matches) {
      panel.current?.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
    } else {
      panel.current?.querySelector<HTMLElement>("[data-close]")?.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened from inside the sheet (e.g. editing a plan item) closes first.
      if (e.key !== "Escape" || document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);

  const conversationId = chat.conversationId;

  return (
    <div
      className={cn("fixed inset-0 z-50", !open && "pointer-events-none invisible")}
      aria-hidden={!open}
      inert={!open}
    >
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "absolute inset-0 bg-[rgb(5_7_12/0.55)] backdrop-blur-[3px] transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Whitespace assistant"
        className={cn(
          "absolute inset-0 flex flex-col bg-surface-3 pt-[env(safe-area-inset-top)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          "sm:inset-y-3 sm:left-auto sm:right-3 sm:w-[min(560px,calc(100vw-1.5rem))] sm:rounded-[24px] sm:border sm:border-border sm:pt-0 sm:shadow-pop",
          open ? "translate-y-0 opacity-100 sm:translate-x-0" : "translate-y-6 opacity-0 sm:translate-x-8 sm:translate-y-0",
        )}
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 pl-5 pr-2 sm:h-16 sm:pl-6 sm:pr-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <AiGlyph className="size-8" />
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">Whitespace</h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {resumed && (
              <Link href="/?new=1" aria-label="New chat" title="New chat" className={ICON_BUTTON}>
                <Plus className="size-[18px]" />
              </Link>
            )}
            <Link
              href={conversationId ? `/assistant?c=${conversationId}` : "/assistant"}
              aria-label="Open full assistant"
              title="Full view"
              className={ICON_BUTTON}
            >
              <ArrowUpRight className="size-[18px]" />
            </Link>
            <button type="button" data-close onClick={() => setOpen(false)} aria-label="Close assistant" className={ICON_BUTTON}>
              <X className="size-[18px]" />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {mounted && <Chat {...chat} mode="assistant" variant="overlay" active={open} />}
        </div>
      </div>
    </div>
  );
}

/** The assistant's mark: a soft violet orb with a spark, used for every way into the assistant on Home. */
export function AiGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 place-items-center rounded-full bg-[radial-gradient(circle_at_30%_25%,var(--brand-from),var(--brand-to)_70%)] text-white shadow-[0_6px_18px_-8px_var(--accent)]",
        className,
      )}
    >
      <Sparkles className="size-[45%]" strokeWidth={2.2} />
    </span>
  );
}

/** Home's discreet way into the assistant: the orb, with a dot when something is waiting there. */
export function AssistantTrigger({ waiting = false }: { waiting?: boolean }) {
  return (
    <button
      type="button"
      onClick={openHomeAssistant}
      aria-label={waiting ? "Open assistant, something is waiting" : "Open assistant"}
      aria-haspopup="dialog"
      className="group relative grid size-12 shrink-0 place-items-center rounded-full border border-border bg-surface shadow-card transition-[transform,border-color,box-shadow] duration-200 hover:border-accent/40 hover:shadow-pop active:scale-95"
    >
      <AiGlyph className="size-9 transition-transform duration-300 group-hover:scale-105" />
      {waiting && (
        <span aria-hidden className="absolute right-0.5 top-0.5 size-2.5 rounded-full border-2 border-surface bg-accent-2" />
      )}
    </button>
  );
}
