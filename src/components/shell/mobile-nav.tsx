"use client";

import { Dialog } from "@/components/ui/dialog";
import { isActive, NAV_ITEMS, type NavItem } from "@/lib/config/navigation";
import { cn } from "@/lib/utils/cn";
import { ChevronRight, LayoutGrid, LogOut, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Brand } from "./brand";

/**
 * Phone and tablet chrome (below lg). A slim top bar with the brand and a
 * "More" sheet for every secondary page, and a floating tab bar with the
 * assistant as the center action. Heights come from --topbar-h / --tabbar-h
 * in globals.css so pages can size themselves around them.
 */

const TABS = NAV_ITEMS.filter((i) => i.mobile);
const MORE = NAV_ITEMS.filter((i) => !i.mobile && i.href !== "/assistant");
const ASSISTANT = NAV_ITEMS.find((i) => i.href === "/assistant")!;

export function MobileTopBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const inMore = MORE.some((i) => isActive(pathname, i.href));

  return (
    <>
      <div className="sticky top-0 z-30 border-b border-border/70 bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150 lg:hidden">
        <div className="flex h-14 items-center justify-between pl-3 pr-2 sm:pl-5 sm:pr-4">
          <Brand />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="More pages"
            aria-haspopup="dialog"
            className={cn(
              "grid size-11 place-items-center rounded-xl transition-[background-color,color,transform] duration-150 active:scale-95",
              inMore ? "text-accent" : "text-ink-2 active:bg-surface-2",
            )}
          >
            <LayoutGrid className="size-[20px]" strokeWidth={1.9} />
          </button>
        </div>
      </div>
      <MoreSheet open={open} onClose={() => setOpen(false)} pathname={pathname} />
    </>
  );
}

const MORE_HINT: Record<string, string> = {
  "/insights": "How your week actually went",
  "/areas": "The parts of life you plan around",
  "/about-you": "What the assistant knows about you",
  "/settings": "Profile, planning and privacy",
};

function MoreSheet({ open, onClose, pathname }: { open: boolean; onClose: () => void; pathname: string }) {
  return (
    <Dialog open={open} onClose={onClose} title="More" size="sm">
      <nav aria-label="More pages" className="-mx-2">
        <ul className="space-y-0.5">
          {MORE.map((item) => (
            <li key={item.href}>
              <MoreLink item={item} active={isActive(pathname, item.href)} onNavigate={onClose} />
            </li>
          ))}
        </ul>
      </nav>
      <form action="/auth/signout" method="post" className="-mx-2 mt-3 border-t border-border pt-3">
        <button
          type="submit"
          className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-[15px] text-ink-2 transition-colors active:bg-surface-2"
        >
          <span className="grid size-9 place-items-center rounded-lg bg-surface-2 text-ink-3">
            <LogOut className="size-[18px]" />
          </span>
          Sign out
        </button>
      </form>
    </Dialog>
  );
}

function MoreLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors active:bg-surface-2",
        active && "bg-accent-soft/60",
      )}
    >
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", active ? "bg-accent text-on-accent" : "bg-surface-2 text-ink-2")}>
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink">{item.label}</span>
        {MORE_HINT[item.href] && <span className="block truncate text-[12.5px] text-ink-3">{MORE_HINT[item.href]}</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" />
    </Link>
  );
}

/** The composer on Home and on the Assistant page shares this id (chat.tsx: `${mode}-input`). */
const COMPOSER_ID = "assistant-input";

/** True while a text field has focus on a touch screen, i.e. the keyboard is likely up. */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    const isField = (el: Element | null) =>
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type)) ||
      (el instanceof HTMLElement && el.isContentEditable);
    const update = () => {
      // Read focus after it settles, so moving between fields doesn't flicker.
      requestAnimationFrame(() => setTyping(coarse.matches && isField(document.activeElement)));
    };
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (typing) root.dataset.typing = "";
    else delete root.dataset.typing;
    return () => {
      delete root.dataset.typing;
    };
  }, [typing]);
  return typing;
}

export function MobileTabBar() {
  const pathname = usePathname();
  const typing = useTyping();
  const left = TABS.slice(0, 2);
  const right = TABS.slice(2);
  const assistantActive = isActive(pathname, ASSISTANT.href);

  // On a page that already has the composer, the center action jumps to it
  // instead of navigating away. Everywhere else it opens the assistant.
  function onAsk(e: MouseEvent<HTMLAnchorElement>) {
    const input = document.getElementById(COMPOSER_ID) as HTMLTextAreaElement | null;
    if (!input) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    input.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
    input.focus({ preventScroll: true });
  }

  return (
    <nav
      aria-label="Primary"
      aria-hidden={typing || undefined}
      inert={typing}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-30 transition-[transform,opacity] duration-200 ease-out lg:hidden",
        typing && "translate-y-full opacity-0",
      )}
    >
      <div className="bg-gradient-to-t from-bg via-bg/80 to-transparent px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-4">
        <ul className="pointer-events-auto mx-auto grid h-[3.75rem] max-w-md grid-cols-5 items-stretch rounded-[22px] border border-border/80 bg-surface/85 px-1 shadow-[0_10px_30px_-10px_rgb(5_7_12/0.35),0_1px_2px_rgb(5_7_12/0.06)] backdrop-blur-xl backdrop-saturate-150">
          {left.map((item) => (
            <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
          <li className="grid place-items-center">
            <Link
              href={ASSISTANT.href}
              onClick={onAsk}
              aria-label="Ask Whitespace"
              aria-current={assistantActive ? "page" : undefined}
              className="group grid size-12 place-items-center rounded-full bg-accent text-on-accent shadow-[0_6px_16px_-4px_color-mix(in_srgb,var(--accent)_60%,transparent)] ring-4 ring-surface/70 transition-transform duration-150 ease-out active:scale-90"
            >
              <Sparkles className="size-[22px] transition-transform duration-300 ease-out group-active:rotate-12" strokeWidth={2} />
            </Link>
          </li>
          {right.map((item) => (
            <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </ul>
      </div>
    </nav>
  );
}

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <li className="min-w-0">
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-full flex-col items-center justify-center gap-0.5 rounded-2xl text-[10.5px] font-medium tracking-[0.01em] transition-[color,transform] duration-150 active:scale-95",
          active ? "text-ink" : "text-ink-3",
        )}
      >
        <span className={cn("grid h-7 w-12 place-items-center rounded-full transition-colors duration-200", active && "bg-accent-soft text-accent")}>
          <Icon className="size-[20px]" strokeWidth={active ? 2.2 : 1.8} />
        </span>
        <span className="truncate">{item.shortLabel ?? item.label}</span>
      </Link>
    </li>
  );
}
