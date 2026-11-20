"use client";

import { isActive, NAV_ITEMS } from "@/lib/config/navigation";
import { cn } from "@/lib/utils/cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Brand } from "./brand";

export function Sidebar({ footer }: { footer: ReactNode }) {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-3 left-3 z-30 hidden w-60 flex-col rounded-[22px] bg-sidebar px-3.5 py-5 text-sidebar-ink shadow-card ring-1 ring-inset ring-white/[0.04] lg:flex">
      <div className="px-2">
        <Brand onDark />
      </div>

      <nav aria-label="Primary" className="mt-8 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex h-10 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-colors duration-150",
                active
                  ? "bg-sidebar-active text-sidebar-ink"
                  : "text-sidebar-ink-2 hover:bg-sidebar-hover hover:text-sidebar-ink",
              )}
            >
              <Icon
                className={cn("size-4 transition-colors", active ? "text-[var(--brand-from)]" : "text-sidebar-ink-2 group-hover:text-sidebar-ink")}
                strokeWidth={2}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto">{footer}</div>
    </aside>
  );
}
