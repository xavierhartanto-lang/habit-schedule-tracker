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
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-bg px-4 py-5 lg:flex">
      <div className="px-2">
        <Brand />
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
                "group relative flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] transition-colors duration-150",
                active
                  ? "bg-accent-soft/70 font-medium text-ink"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <Icon
                className={cn("size-4 transition-colors", active ? "text-accent" : "text-ink-3 group-hover:text-ink-2")}
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
