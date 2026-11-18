"use client";

import { isActive, NAV_ITEMS } from "@/lib/config/navigation";
import { cn } from "@/lib/utils/cn";
import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "./brand";

export function MobileTopBar() {
  const pathname = usePathname();
  const active = isActive(pathname, "/settings");
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg/85 px-4 backdrop-blur lg:hidden">
      <Brand />
      <Link
        href="/settings"
        aria-label="Settings"
        aria-current={active ? "page" : undefined}
        className={cn(
          "grid size-9 place-items-center rounded-lg transition-colors",
          active ? "bg-surface text-accent shadow-card" : "text-ink-2 hover:bg-surface-2",
        )}
      >
        <Settings className="size-[18px]" />
      </Link>
    </div>
  );
}

export function MobileTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch justify-around px-2">
        {NAV_ITEMS.filter((i) => i.mobile).map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                  active ? "text-accent" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
                {item.shortLabel ?? item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
