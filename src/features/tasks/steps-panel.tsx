"use client";

import { Button, Input } from "@/components/ui";
import type { ProposedStep } from "@/lib/assistant/breakdown";
import type { Task } from "@/lib/domain/types";
import { formatDuration } from "@/lib/scheduling/time";
import { ListTree, Sparkles, X } from "lucide-react";
import { useState, useTransition } from "react";
import { proposeSteps, saveSteps } from "./actions";
import { formatDue } from "./format";

/**
 * Phase 7.3: break a task into steps. Whitespace proposes them (names and
 * sizes from the AI, dates spread evenly before the task is due); nothing is
 * saved until the user taps Save. Each step becomes a real task.
 */
export function StepsPanel({
  task,
  steps,
  timeZone,
  todayKey,
  disabled,
  onSaved,
}: {
  task: Task;
  /** Steps already saved for this task. */
  steps: Task[];
  timeZone: string;
  todayKey: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [proposal, setProposal] = useState<ProposedStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (task.parentTaskId) return null;

  if (steps.length) {
    const done = steps.filter((s) => s.status === "done").length;
    return (
      <section aria-label="Steps" className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
          <ListTree className="size-3.5 text-ink-3" /> Steps <span className="font-normal text-ink-3">{done} of {steps.length} done</span>
        </p>
        <ul className="space-y-1">
          {steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className={s.status === "done" ? "text-ink-3 line-through" : ""}>{s.title}</span>
              {s.dueAt && <span className="text-[12px] text-ink-3">{formatDue(s.dueAt, timeZone, todayKey)}</span>}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const suggest = () =>
    start(async () => {
      setError(null);
      const r = await proposeSteps(task.id);
      if (r.ok) setProposal(r.steps);
      else setError(r.error);
    });

  const save = () =>
    start(async () => {
      if (!proposal) return;
      setError(null);
      const r = await saveSteps(task.id, proposal);
      if (r.ok) onSaved();
      else setError(r.error);
    });

  const rename = (i: number, title: string) => setProposal((p) => p && p.map((s, j) => (j === i ? { ...s, title } : s)));
  const drop = (i: number) => setProposal((p) => p && p.filter((_, j) => j !== i));

  return (
    <section aria-label="Steps" className="space-y-2 rounded-xl border border-border p-3">
      {!proposal ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-ink-2">Big task? Whitespace can split it into smaller steps.</p>
          <Button type="button" variant="secondary" size="sm" onClick={suggest} disabled={disabled || pending}>
            <Sparkles className="size-3.5" /> {pending ? "Thinking…" : "Suggest steps"}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-[13px] font-medium text-ink">Suggested steps</p>
          <ol className="space-y-1.5">
            {proposal.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Step ${i + 1}`}
                  value={s.title}
                  maxLength={120}
                  onChange={(e) => rename(i, e.target.value)}
                  // The panel sits inside the task form: Enter here must not save the task.
                  onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                  className="h-8 flex-1 text-[13px]"
                />
                <span className="w-24 shrink-0 text-right text-[12px] text-ink-3">
                  {formatDuration(s.minutes)}
                  {s.dueAt ? ` · ${formatDue(s.dueAt, timeZone, todayKey)}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => drop(i)}
                  className="hit-area grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ol>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setProposal(null)} disabled={pending}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={pending || disabled || !proposal.length || proposal.some((s) => !s.title.trim())}>
              {pending ? "Saving…" : `Save ${proposal.length} step${proposal.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
