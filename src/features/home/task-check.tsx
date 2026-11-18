"use client";

import { cn } from "@/lib/utils/cn";
import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { setTaskDone } from "@/features/tasks/actions";

/** Check a task off from Home. */
export function TaskCheck({ id, title, inProgress }: { id: string; title: string; inProgress: boolean }) {
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`Mark "${title}" done`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          setDone(true);
          const r = await setTaskDone(id, true);
          if (!r.ok) setDone(false);
        })
      }
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-md border-[1.5px] transition-colors",
        done ? "border-transparent bg-ink text-bg" : "border-border-strong hover:border-accent",
        inProgress && !done && "border-accent bg-accent-soft",
      )}
    >
      {done && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}
