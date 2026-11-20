"use client";

import type { SessionOutcome } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { recordSessionOutcome } from "@/features/sessions/actions";

const CHOICES: { value: SessionOutcome; label: string; done: string }[] = [
  { value: "done", label: "Done", done: "Done" },
  { value: "partial", label: "Partly", done: "Partly done" },
  { value: "missed", label: "Missed", done: "Missed" },
];

/**
 * "How did it go?" for a Whitespace work session that has started. Records
 * a fact only (plan vs reality); it never moves anything. A missed session
 * gets a "find another slot" suggestion from the engine on the next load.
 */
export function SessionOutcomeChips({ id, outcome }: { id: string; outcome: SessionOutcome | null }) {
  const [value, setValue] = useState<SessionOutcome | null>(outcome);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = (next: SessionOutcome) => {
    const before = value;
    setValue(next);
    setEditing(false);
    setError(null);
    start(async () => {
      const r = await recordSessionOutcome({ id, outcome: next });
      if (!r.ok) {
        setValue(before);
        setError(r.error);
      }
    });
  };

  if (value && !editing) {
    const label = CHOICES.find((c) => c.value === value)!.done;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="ml-[70px] flex basis-full items-center gap-1 text-left text-[11.5px] text-ink-3 hover:text-ink-2"
        aria-label={`${label}. Change`}
      >
        <Check aria-hidden className="size-3" />
        {label}
      </button>
    );
  }

  return (
    <div className="ml-[70px] basis-full">
      <p className="mb-1 text-[11.5px] text-ink-3">How did it go?</p>
      <div role="group" aria-label="How did this session go?" className="flex flex-wrap items-center gap-1">
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            disabled={pending}
            onClick={() => save(c.value)}
            className={cn(
              "min-h-7 rounded-full bg-surface-2 px-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent-ink disabled:opacity-60",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}
