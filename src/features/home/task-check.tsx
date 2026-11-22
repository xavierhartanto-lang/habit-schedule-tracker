"use client";

import { cn } from "@/lib/utils/cn";
import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { setTaskDone } from "@/features/tasks/actions";

/** Check a task off from Home. A repeating task stays on the list and comes back next time. */
export function TaskCheck({ id, title, inProgress, repeats }: { id: string; title: string; inProgress: boolean; repeats?: boolean }) {
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={repeats ? `Done for now, "${title}" comes back next time` : `Mark "${title}" done`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          setDone(true);
          const r = await setTaskDone(id, true);
          if (!r.ok || repeats) setDone(false);
        })
      }
      className={cn(
        "hit-area grid size-[18px] shrink-0 place-items-center rounded-md pointer-coarse:size-[22px] border-[1.5px] transition-[background-color,border-color,transform] duration-150 active:scale-90",
        done ? "border-transparent bg-accent text-on-accent" : "border-border-strong hover:border-accent",
        inProgress && !done && "border-accent bg-accent-soft",
      )}
    >
      {done && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}
