"use client";

import { AreaDot } from "@/components/ui";
import { buttonClasses } from "@/components/ui/button";
import {
  LIFE_AREA_VALUES,
  WEEKDAY_VALUES,
  type Clarification,
  type ContextCategory,
  type ExtractedItem,
  type Weekday,
} from "@/lib/ai/extraction";
import type { AiErrorCode } from "@/lib/ai/errors";
import { LIFE_AREAS } from "@/lib/domain/life-areas";
import { cn } from "@/lib/utils/cn";
import { Check, CircleHelp, Lock, Move, Pencil, Quote, RotateCcw, X } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { saveAllProposals, saveProposal, setProposalDismissed, type ProposalActionResult } from "./actions";
import { DAY_SHORT, describeSchedule, needsSchedule, type ProposalEdit } from "./proposal-input";
import type { Proposal } from "./types";

/**
 * Facts the AI noticed in one user message, shown as suggestions.
 * Nothing is saved until the user taps Save (or Save all).
 */

const CATEGORY_LABEL: Record<ContextCategory, string> = {
  commitment: "Commitment",
  goal: "Goal",
  activity: "Activity",
  interest: "Interest",
  routine: "Routine",
  working_time: "Working time",
  preference: "Preference",
};

export function ProposalGroup({
  messageId,
  proposals,
  clarifications,
  extractionError,
  onProposalsChange,
  onAnswer,
}: {
  messageId: string;
  proposals: Proposal[];
  clarifications: Clarification[];
  extractionError: AiErrorCode | null;
  onProposalsChange: (messageId: string, proposals: Proposal[]) => void;
  onAnswer?: (question: string) => void;
}) {
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const visible = proposals.length > 0;
  if (!visible && clarifications.length === 0) {
    if (extractionError && extractionError !== "not_configured") {
      return (
        <p className="pl-10 text-[12px] text-ink-3">
          Couldn&apos;t check this message for things to remember. Your conversation is fine.
        </p>
      );
    }
    return null;
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const readyCount = pending.filter((p) => !needsSchedule(p.item)).length;

  const run = (action: () => Promise<ProposalActionResult>, after?: (r: ProposalActionResult) => void) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (result.proposals) onProposalsChange(messageId, result.proposals);
      if (!result.ok) setError(result.error);
      after?.(result);
    });
  };

  return (
    <div className="pl-10 animate-fade-up">
      {visible && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2/60 px-3.5 py-2">
            <p className="text-[12px] font-medium text-ink-2">
              {pending.length > 0
                ? `Save to what Whitespace knows? ${pending.length === 1 ? "1 suggestion" : `${pending.length} suggestions`}`
                : "Suggestions from this message"}
            </p>
            {readyCount > 1 && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    () => saveAllProposals({ messageId }),
                    (r) => {
                      if (r.ok && r.skipped) setNotice(`${r.skipped} need more details before they can be saved.`);
                    },
                  )
                }
                className={buttonClasses("secondary", "sm", "h-7 px-2.5 text-[12px]")}
              >
                <Check className="size-3.5" /> Save all
              </button>
            )}
          </div>

          <ul className="divide-y divide-border">
            {proposals.map((p) => (
              <li key={p.id}>
                {editing === p.id ? (
                  <ProposalEditor
                    item={p.item}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={(edit) =>
                      run(
                        () => saveProposal({ messageId, proposalId: p.id, edit }),
                        (r) => r.ok && setEditing(null),
                      )
                    }
                  />
                ) : (
                  <ProposalRow
                    proposal={p}
                    busy={busy}
                    onSave={() => run(() => saveProposal({ messageId, proposalId: p.id }))}
                    onEdit={() => {
                      setError(null);
                      setEditing(p.id);
                    }}
                    onDismiss={(dismissed) =>
                      run(() => setProposalDismissed({ messageId, proposalId: p.id, dismissed }))
                    }
                  />
                )}
              </li>
            ))}
          </ul>

          {(error || notice) && (
            <p
              role={error ? "alert" : "status"}
              className={cn("border-t border-border px-3.5 py-2 text-[12px]", error ? "text-danger" : "text-ink-3")}
            >
              {error ?? notice}
            </p>
          )}
        </div>
      )}

      {clarifications.length > 0 && (
        <div className={cn("flex flex-wrap items-center gap-1.5", visible && "mt-2.5")}>
          <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">
            <CircleHelp className="size-3.5" /> To get this right:
          </span>
          {clarifications.map((c) => (
            <button
              key={c.question}
              type="button"
              onClick={() => onAnswer?.(c.question)}
              className="rounded-full border border-border bg-surface px-2.5 py-1 text-left text-[12px] text-ink-2 transition-colors hover:border-accent/40 hover:text-ink"
            >
              {c.question}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalRow({
  proposal,
  busy,
  onSave,
  onEdit,
  onDismiss,
}: {
  proposal: Proposal;
  busy: boolean;
  onSave: () => void;
  onEdit: () => void;
  onDismiss: (dismissed: boolean) => void;
}) {
  const { item, status } = proposal;
  const incomplete = status === "pending" && needsSchedule(item);
  const summary = summarize(item);

  return (
    <div className={cn("flex flex-col gap-2.5 px-3.5 py-3 sm:flex-row sm:items-start", status === "dismissed" && "opacity-55")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
            <AreaDot area={item.area} />
            {CATEGORY_LABEL[item.category]}
            {item.category === "commitment" &&
              (item.kind === "fixed" ? (
                <Lock aria-label="Fixed time" className="size-3" />
              ) : (
                <Move aria-label="Flexible" className="size-3" />
              ))}
          </span>
          {item.supersedes && (
            <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
              Updates “{item.supersedes}”
            </span>
          )}
        </div>
        <p className={cn("mt-1 text-sm font-medium text-ink", status === "dismissed" && "line-through")}>{item.title}</p>
        {summary && <p className="mt-0.5 text-[13px] text-ink-2">{summary}</p>}
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] italic text-ink-3">
          <Quote aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0">
            <span className="sr-only">You said: </span>
            {item.evidence}
          </span>
        </p>
        {incomplete && (
          <p className="mt-1.5 text-[12px] font-medium text-[var(--cat-creative)]">
            Add the days and times to save this.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {status === "saved" ? (
          <span className="inline-flex h-8 items-center gap-1.5 px-2 text-[13px] font-medium text-success">
            <Check className="size-4" /> {proposal.saved?.updated ? "Updated" : "Saved"}
          </span>
        ) : status === "dismissed" ? (
          <button type="button" disabled={busy} onClick={() => onDismiss(false)} className={buttonClasses("ghost", "sm")}>
            <RotateCcw className="size-3.5" /> Undo
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDismiss(true)}
              aria-label={`Dismiss ${item.title}`}
              className={buttonClasses("ghost", "sm", "px-2")}
            >
              <X className="size-4" />
            </button>
            <button type="button" disabled={busy} onClick={onEdit} className={buttonClasses("secondary", "sm")}>
              <Pencil className="size-3.5" /> Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={incomplete ? onEdit : onSave}
              className={buttonClasses("primary", "sm")}
            >
              <Check className="size-3.5" /> {incomplete ? "Add details" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function summarize(item: ExtractedItem): string {
  if (item.category === "goal") {
    const horizon = item.horizon === "long_term" ? "Long term" : item.horizon === "short_term" ? "Short term" : null;
    const date = item.targetDate
      ? `by ${new Date(`${item.targetDate}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
      : null;
    return [horizon, date, item.details].filter(Boolean).join(" · ");
  }
  const schedule = describeSchedule(item.schedule);
  const location = item.category === "commitment" && item.location ? `at ${item.location}` : null;
  return [schedule, location, item.details].filter(Boolean).join(" · ");
}

const inputClass =
  "h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

function ProposalEditor({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item: ExtractedItem;
  busy: boolean;
  onSave: (edit: ProposalEdit) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(item.title);
  const [area, setArea] = useState(item.area);
  const [details, setDetails] = useState(item.details ?? "");
  const schedule = item.category === "goal" ? null : item.schedule;
  const [days, setDays] = useState<Weekday[]>(schedule?.days ?? []);
  const [startTime, setStartTime] = useState(schedule?.startTime ?? "");
  const [endTime, setEndTime] = useState(schedule?.endTime ?? "");
  const [kind, setKind] = useState(item.category === "commitment" ? item.kind : "fixed");
  const [horizon, setHorizon] = useState(item.category === "goal" ? (item.horizon ?? "") : "");
  const [targetDate, setTargetDate] = useState(item.category === "goal" ? (item.targetDate ?? "") : "");

  const isGoal = item.category === "goal";
  const isCommitment = item.category === "commitment";
  const showSchedule = !isGoal && !(isCommitment && kind === "flexible");

  const submit = () => {
    const edit: ProposalEdit = { title, area, details: details || null };
    if (isGoal) {
      edit.horizon = horizon === "short_term" || horizon === "long_term" ? horizon : null;
      edit.targetDate = targetDate || null;
    } else {
      if (isCommitment) edit.kind = kind;
      if (showSchedule) {
        edit.days = days;
        edit.startTime = startTime || null;
        edit.endTime = endTime || null;
      }
    }
    onSave(edit);
  };

  return (
    <form
      className="space-y-3 bg-surface-2/40 px-3.5 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-ink-2">Name</span>
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-ink-2">Life area</span>
          <select className={inputClass} value={area} onChange={(e) => setArea(e.target.value as typeof area)}>
            {LIFE_AREA_VALUES.map((a) => (
              <option key={a} value={a}>
                {LIFE_AREAS[a].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isCommitment && (
        <fieldset>
          <legend className="mb-1 text-[12px] font-medium text-ink-2">Timing</legend>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {(["fixed", "flexible"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                  kind === k ? "bg-ink text-bg" : "text-ink-2 hover:text-ink",
                )}
              >
                {k === "fixed" ? "Set time" : "Flexible"}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {showSchedule && (
        <div className="space-y-3">
          <fieldset>
            <legend className="mb-1 text-[12px] font-medium text-ink-2">Days</legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_VALUES.map((d) => {
                const on = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDays((cur) => (on ? cur.filter((x) => x !== d) : [...cur, d]))}
                    className={cn(
                      "h-8 w-11 rounded-lg border text-[12px] font-medium transition-colors",
                      on ? "border-accent bg-accent-soft text-accent-ink" : "border-border bg-surface text-ink-2 hover:border-border-strong",
                    )}
                  >
                    {DAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">Starts</span>
              <input type="time" className={inputClass} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-2">Ends</span>
              <input type="time" className={inputClass} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      {isGoal && (
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Horizon</span>
            <select className={inputClass} value={horizon} onChange={(e) => setHorizon(e.target.value as typeof horizon)}>
              <option value="">Not sure</option>
              <option value="short_term">Short term</option>
              <option value="long_term">Long term</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Target date</span>
            <input type="date" className={inputClass} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
        </div>
      )}

      <label className="block" htmlFor={`${id}-details`}>
        <span className="mb-1 block text-[12px] font-medium text-ink-2">Notes</span>
        <input
          id={`${id}-details`}
          className={inputClass}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={500}
          placeholder="Optional"
        />
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={buttonClasses("ghost", "sm")}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !title.trim()} className={buttonClasses("primary", "sm")}>
          <Check className="size-3.5" /> Save
        </button>
      </div>
    </form>
  );
}
