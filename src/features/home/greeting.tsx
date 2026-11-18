"use client";

import { useNow } from "@/lib/hooks/use-now";
import type { ReactNode } from "react";

function partOfDay(h: number) {
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function Greeting({ name }: { name: ReactNode }) {
  const now = useNow();
  return (
    <div className="animate-fade-up">
      <p className="h-5 text-[13px] font-medium text-ink-3">
        {now?.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
      </p>
      <h1 className="mt-1 text-[26px] font-semibold tracking-tight text-ink sm:text-[30px]">
        {now ? partOfDay(now.getHours()) : "Welcome back"}
        {name}
      </h1>
      <p className="mt-1 text-[15px] text-ink-2">Here is what your day looks like.</p>
    </div>
  );
}
