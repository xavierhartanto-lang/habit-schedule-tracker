"use client";

import { buttonClasses } from "@/components/ui/button";
import { formatDuration } from "@/lib/scheduling/time";
import { dateKeyInZone, formatDateKey, formatTimeInZone, timeKeyInZone, zonedToUtc } from "@/lib/scheduling/zoned";
import { cn } from "@/lib/utils/cn";
import {
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  Check,
  CircleAlert,
  Clock,
  ListChecks,
  Lock,
  Pencil,
  RefreshCw,
  Repeat,
  RotateCcw,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";
import type { PlanActionResult, PlanItem, PlanItemAction, PlanView } from "./plan-types";

/**
 * Approval card for a plan the assistant proposed. Nothing in the
 * "calendar" group reaches the calendar until the user approves it.
 * Supports approve all / selected, edit a time, ask for other times,
 * reject, and undo for items that allow it. Every server call returns the
 * fresh plan, which replaces local state.
 */

export type PlanCardActions = {
  approve: (input: {
    planId: string;
    itemIds?: string[];
    requestId: string;
  }) => Promise<PlanActionResult>;
  reject: (input: { planId: string; itemIds?: string[] }) => Promise<PlanActionResult>;
  edit: (input: { planId: string; itemId: string; start: string; end: string }) => Promise<PlanActionResult>;
  alternatives: (input: { planId: string; itemIds: string[] }) => Promise<PlanActionResult>;
  undo: (input: { planId: string; itemId: string }) => Promise<PlanActionResult>;
};

const ACTION_LABEL: Record<PlanItemAction, string> = {
  create_event: "New event",
  schedule_block: "Work session",
  move_block: "Move",
  remove_block: "Remove",
  remove_event: "Remove event",
  skip_occurrence: "Skip once",
  create_task: "New task",
  update_task: "Update task",
  complete_task: "Complete task",
  remove_task: "Delete task",
  create_habit: "New habit",
  update_habit: "Update habit",
  create_goal: "New goal",
  update_goal: "Update goal",
  set_life_area: "Life area",
  update_preferences: "Preferences",
  save_fact: "Remember",
};

const DONE_LABEL: Partial<Record<PlanItemAction, string>> = {
  create_event: "Added",
  schedule_block: "Added",
  move_block: "Moved",
  remove_block: "Removed",
  remove_event: "Removed",
  skip_occurrence: "Skipped",
  complete_task: "Done",
  remove_task: "Deleted",
  save_fact: "Saved",
};

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const isOpen = (i: PlanItem) => i.status === "pending" || i.status === "conflict" || i.status === "failed";

function dayLabel(iso: string, tz: string) {
  return formatDateKey(dateKeyInZone(new Date(iso), tz), { weekday: "short", month: "short", day: "numeric" });
}

function timeRange(start: string, end: string, tz: string) {
  return `${formatTimeInZone(new Date(start), tz)} – ${formatTimeInZone(new Date(end), tz)}`;
}

type Feedback = { tone: "ok" | "warn" | "error"; text: string };

function describeResult(result: Extract<PlanActionResult, { ok: true }>, verb: string): Feedback {
  const count = (o: string[]) => result.results.filter((r) => o.includes(r.outcome)).length;
  const done = count(["applied", "already_applied"]);
  const blocked = count(["conflict", "stale"]);
  const failed = count(["failed"]);
  if (verb === "reject") return { tone: "ok", text: "Rejected. Nothing on your calendar changed." };
  if (verb === "undo") return { tone: "ok", text: "Undone." };
  if (verb === "edit") return { tone: "ok", text: "Time updated. Approve it when it looks right." };
  if (verb === "alternatives")
    return { tone: "ok", text: "Found other times. Your calendar wasn't changed." };
  if (blocked || failed) {
    const parts = [
      done ? `Approved ${done}.` : "",
      blocked ? `${blocked} no longer fit${blocked === 1 ? "s" : ""} because your schedule changed.` : "",
      failed ? `${failed} couldn't be saved.` : "",
    ];
    return { tone: "warn", text: parts.filter(Boolean).join(" ") };
  }
  return { tone: "ok", text: done === 1 ? "Approved. It's on your calendar." : `Approved ${done}. Your calendar is updated.` };
}

export function PlanCard({
  plan: initialPlan,
  actions,
  disabled = false,
}: {
  plan: PlanView;
  actions: PlanCardActions;
  disabled?: boolean;
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialPlan.items.filter((i) => isOpen(i) && !i.autoApplied).map((i) => i.id)),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // One idempotency key per approval attempt, kept if the attempt fails to reach the server.
  const attempt = useRef<string | null>(null);

  const receipts = plan.items.filter((i) => i.autoApplied);
  const items = plan.items.filter((i) => !i.autoApplied).sort((a, b) => a.position - b.position);
  const open = items.filter(isOpen);
  const chosen = open.filter((i) => selected.has(i.id));
  const chosenMinutes = chosen.reduce((s, i) => s + (i.timing?.durationMinutes ?? 0), 0);
  const locked = busy || disabled;

  const run = (verb: string, call: () => Promise<PlanActionResult>, after?: () => void) => {
    if (locked) return;
    setFeedback(null);
    start(async () => {
      let result: PlanActionResult;
      try {
        result = await call();
      } catch {
        setFeedback({ tone: "error", text: "Couldn't reach Whitespace. Nothing changed. Try again." });
        return;
      }
      if (result.plan) {
        const fresh = result.plan;
        setPlan(fresh);
        setSelected((s) => new Set(fresh.items.filter((i) => isOpen(i) && !i.autoApplied && (s.has(i.id) || verb !== "approve")).map((i) => i.id)));
      }
      if (!result.ok) {
        setFeedback({ tone: "error", text: result.error });
        return;
      }
      setFeedback(describeResult(result, verb));
      after?.();
    });
  };

  const approve = (ids: string[]) => {
    if (!ids.length) return;
    const requestId = attempt.current ?? newRequestId();
    attempt.current = requestId;
    const all = ids.length === open.length;
    run(
      "approve",
      () => actions.approve({ planId: plan.id, itemIds: all ? undefined : ids, requestId }),
      () => {
        attempt.current = null;
      },
    );
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items.length === 0) {
    return receipts.length ? (
      <Receipts items={receipts} locked={locked} onUndo={(id) => run("undo", () => actions.undo({ planId: plan.id, itemId: id }))} feedback={feedback} />
    ) : null;
  }

  const calendarCount = items.filter((i) => i.group === "calendar").length;
  const allChosen = open.length > 0 && chosen.length === open.length;
  const header =
    plan.status === "applied"
      ? "All set"
      : plan.status === "rejected"
        ? "Plan dismissed"
        : open.length === 0
          ? "Plan reviewed"
          : calendarCount > 0
            ? `Proposed plan · ${open.length} to review`
            : `Suggested changes · ${open.length} to review`;

  return (
    <div className="space-y-2">
      {receipts.length > 0 && (
        <Receipts items={receipts} locked={locked} onUndo={(id) => run("undo", () => actions.undo({ planId: plan.id, itemId: id }))} />
      )}
      <section
        aria-label={calendarCount > 0 ? "Proposed schedule" : "Suggested changes"}
        className={cn(
          "overflow-hidden rounded-xl border bg-surface shadow-card animate-fade-up transition-colors duration-300",
          open.length > 0 && !locked ? "border-accent/35" : "border-border",
        )}
      >
        <header className="flex items-start gap-3 border-b border-border px-3.5 py-3">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
            {plan.status === "applied" ? (
              <CalendarCheck className="size-3.5" />
            ) : calendarCount > 0 ? (
              <CalendarClock className="size-3.5" />
            ) : (
              <ListChecks className="size-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">{header}</p>
            {plan.summary && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{plan.summary}</p>}
          </div>
        </header>

        {plan.status === "stale" && open.length > 0 && (
          <p className="flex items-start gap-1.5 border-b border-border px-3.5 py-2.5 text-[12px] text-ink-2">
            <RotateCcw className="mt-px size-3.5 shrink-0 text-ink-3" />
            Your calendar may have changed since this was suggested. Each time is checked again when you approve.
          </p>
        )}

        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              {editing === item.id && item.timing ? (
                <TimeEditor
                  item={item}
                  timeZone={item.timing.timeZone}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(t) =>
                    run("edit", () => actions.edit({ planId: plan.id, itemId: item.id, ...t }), () => setEditing(null))
                  }
                />
              ) : (
                <PlanRow
                  item={item}
                  selected={selected.has(item.id)}
                  locked={locked}
                  onToggle={() => toggle(item.id)}
                  onEdit={() => {
                    setFeedback(null);
                    setEditing(item.id);
                  }}
                  onReject={() => run("reject", () => actions.reject({ planId: plan.id, itemIds: [item.id] }))}
                  onAlternative={() => run("alternatives", () => actions.alternatives({ planId: plan.id, itemIds: [item.id] }))}
                  onUndo={() => run("undo", () => actions.undo({ planId: plan.id, itemId: item.id }))}
                />
              )}
            </li>
          ))}
        </ul>

        {plan.unscheduled.length > 0 && (
          <div className="border-t border-border bg-[var(--cat-creative-soft)] px-3.5 py-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <TriangleAlert className="size-3.5 text-[var(--cat-creative)]" /> Didn&apos;t fit
            </p>
            <ul className="mt-1 space-y-0.5">
              {plan.unscheduled.map((s) => (
                <li key={s.title} className="text-[12px] leading-relaxed text-ink-2">
                  <span className="font-medium text-ink">{s.title}</span>
                  {s.minutes > 0 && <> ({formatDuration(s.minutes)} short)</>}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {feedback && <FeedbackLine feedback={feedback} />}

        {open.length > 0 && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3.5 py-2.5">
            <p className="text-[12px] text-ink-3">
              {chosen.length === 0
                ? "Nothing selected"
                : `${chosen.length} selected${chosenMinutes ? ` · ${formatDuration(chosenMinutes)}` : ""}`}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={locked}
                onClick={() => run("reject", () => actions.reject({ planId: plan.id }))}
                className={buttonClasses("ghost", "sm")}
              >
                Reject all
              </button>
              <button
                type="button"
                disabled={locked || chosen.length === 0}
                onClick={() => approve(chosen.map((i) => i.id))}
                className={buttonClasses("primary", "sm")}
              >
                <Check className="size-3.5" />
                {busy ? "Working…" : allChosen ? "Approve all" : `Approve ${chosen.length}`}
              </button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12px]",
        feedback.tone === "error" ? "text-danger" : feedback.tone === "warn" ? "text-ink-2" : "text-success",
      )}
    >
      {feedback.tone === "ok" ? <Check className="mt-px size-3.5 shrink-0" /> : <CircleAlert className="mt-px size-3.5 shrink-0" />}
      {feedback.text}
    </p>
  );
}

function StatusTag({ item }: { item: PlanItem }) {
  switch (item.status) {
    case "applied":
      return <span className="text-[11px] font-medium text-success">{DONE_LABEL[item.action] ?? "Done"}</span>;
    case "rejected":
      return <span className="text-[11px] font-medium text-ink-3">Rejected</span>;
    case "undone":
      return <span className="text-[11px] font-medium text-ink-3">Undone</span>;
    case "conflict":
      return <span className="text-[11px] font-medium text-danger">Conflict</span>;
    case "failed":
      return <span className="text-[11px] font-medium text-danger">Not saved</span>;
    default:
      return null;
  }
}

function PlanRow({
  item,
  selected,
  locked,
  onToggle,
  onEdit,
  onReject,
  onAlternative,
  onUndo,
}: {
  item: PlanItem;
  selected: boolean;
  locked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onReject: () => void;
  onAlternative: () => void;
  onUndo: () => void;
}) {
  const open = isOpen(item);
  const t = item.timing;
  const checkboxId = useId();
  const closed = item.status === "rejected" || item.status === "undone";
  const canRetime = open && item.editable && t && !t.allDay;
  const canAlternate = open && item.action === "schedule_block";

  return (
    <div className={cn("flex gap-3 px-3.5 py-3", closed && "opacity-55")}>
      <div className="pt-0.5">
        {open ? (
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            disabled={locked}
            onChange={onToggle}
            className="size-4 cursor-pointer rounded accent-[var(--accent)] pointer-coarse:size-5"
          />
        ) : item.status === "applied" ? (
          <Check aria-hidden className="size-4 text-success" />
        ) : (
          <X aria-hidden className="size-4 text-ink-3" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
          {item.action === "create_event" && <Lock aria-label="Fixed" className="size-3" />}
          {ACTION_LABEL[item.action]}
        </p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
          <label
            htmlFor={open ? checkboxId : undefined}
            className={cn("text-sm font-medium text-ink", open && "cursor-pointer", closed && "line-through")}
          >
            {item.title}
          </label>
          <StatusTag item={item} />
        </div>

        {t ? (
          <div className="mt-0.5 text-[13px] tabular-nums text-ink-2">
            {item.previous && (
              <p className="flex flex-wrap items-center gap-x-1.5 text-ink-3 line-through">
                {dayLabel(item.previous.start, t.timeZone)}, {timeRange(item.previous.start, item.previous.end, t.timeZone)}
              </p>
            )}
            <p className="flex flex-wrap items-center gap-x-1.5">
              {item.previous && <ArrowRight aria-hidden className="size-3 text-ink-3" />}
              <span>{dayLabel(t.start, t.timeZone)}</span>
              <span aria-hidden className="text-ink-3">·</span>
              <span>{t.allDay ? "All day" : timeRange(t.start, t.end, t.timeZone)}</span>
              {!t.allDay && (
                <>
                  <span aria-hidden className="text-ink-3">·</span>
                  <span className="inline-flex items-center gap-1 text-ink-3">
                    <Clock aria-hidden className="size-3" />
                    {formatDuration(t.durationMinutes)}
                  </span>
                </>
              )}
            </p>
            {t.recurrence && (
              <p className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-ink-3">
                <Repeat aria-hidden className="size-3" /> {t.recurrence}
              </p>
            )}
          </div>
        ) : (
          item.detail && <p className="mt-0.5 text-[13px] text-ink-2">{item.detail}</p>
        )}

        {item.reason && (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            <span className="sr-only">Why: </span>
            {item.reason}
          </p>
        )}
        {open &&
          [...item.tradeoffs, ...item.warnings].map((text) => (
            <p key={text} className="mt-1 flex items-start gap-1 text-[12px] leading-relaxed text-ink-2">
              <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-[var(--cat-creative)]" />
              <span>
                <span className="sr-only">Trade-off: </span>
                {text}
              </span>
            </p>
          ))}
        {open &&
          item.conflicts.map((c) => (
            <p key={c.title + c.start} className="mt-1 flex items-start gap-1 text-[12px] leading-relaxed text-danger">
              <CircleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>
                Overlaps {c.title} ({dayLabel(c.start, t?.timeZone ?? "UTC")}, {timeRange(c.start, c.end, t?.timeZone ?? "UTC")})
                {c.kind === "fixed" && ". Fixed events are never moved."}
              </span>
            </p>
          ))}
        {item.error && (item.status === "conflict" || item.status === "failed") && (
          <p className="mt-1 text-[12px] text-danger">{item.error}</p>
        )}

        {!locked && (open || (item.status === "applied" && item.canUndo)) && (
          <div className="-ml-2 mt-1.5 flex flex-wrap items-center gap-0.5">
            {canRetime && (
              <button type="button" onClick={onEdit} className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px] text-ink-3")}>
                <Pencil className="size-3" /> Edit
              </button>
            )}
            {canAlternate && (
              <button type="button" onClick={onAlternative} className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px] text-ink-3")}>
                <RefreshCw className="size-3" /> Other times
              </button>
            )}
            {open && (
              <button
                type="button"
                onClick={onReject}
                aria-label={`Reject ${item.title}`}
                className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px] text-ink-3 hover:text-danger")}
              >
                <X className="size-3" /> Reject
              </button>
            )}
            {item.status === "applied" && item.canUndo && (
              <button type="button" onClick={onUndo} className={buttonClasses("ghost", "sm", "h-7 px-2 text-[12px] text-ink-3")}>
                <Undo2 className="size-3" /> Undo
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small "done" receipts for actions the assistant applied because the user asked directly. */
function Receipts({
  items,
  locked,
  onUndo,
  feedback,
}: {
  items: PlanItem[];
  locked: boolean;
  onUndo: (id: string) => void;
  feedback?: Feedback | null;
}) {
  return (
    <div className="space-y-1 animate-fade-up">
      {items.map((i) => {
        const undone = i.status === "undone";
        return (
          <div
            key={i.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-[12px]"
          >
            {undone ? (
              <Undo2 aria-hidden className="size-3.5 shrink-0 text-ink-3" />
            ) : i.status === "failed" ? (
              <CircleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
            ) : (
              <Check aria-hidden className="size-3.5 shrink-0 text-success" />
            )}
            <span className={cn("min-w-0 flex-1 truncate text-ink-2", undone && "line-through")}>
              <span className="font-medium text-ink">{ACTION_LABEL[i.action]}:</span> {i.title}
              {i.detail && <span className="text-ink-3"> · {i.detail}</span>}
              {i.status === "failed" && i.error && <span className="text-danger"> · {i.error}</span>}
            </span>
            {i.status === "applied" && i.canUndo && (
              <button
                type="button"
                disabled={locked}
                onClick={() => onUndo(i.id)}
                className="shrink-0 font-medium text-accent-ink hover:underline disabled:opacity-50"
              >
                Undo
              </button>
            )}
          </div>
        );
      })}
      {feedback && feedback.tone === "error" && <p role="alert" className="px-1 text-[12px] text-danger">{feedback.text}</p>}
    </div>
  );
}

function TimeEditor({
  item,
  timeZone,
  busy,
  onSave,
  onCancel,
}: {
  item: PlanItem;
  timeZone: string;
  busy: boolean;
  onSave: (edit: { start: string; end: string }) => void;
  onCancel: () => void;
}) {
  const s = new Date(item.timing!.start);
  const e = new Date(item.timing!.end);
  const [date, setDate] = useState(dateKeyInZone(s, timeZone));
  const [from, setFrom] = useState(timeKeyInZone(s, timeZone));
  const [to, setTo] = useState(timeKeyInZone(e, timeZone));
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const save = () => {
    if (!date || !from || !to) return setError("Pick a date, start and end.");
    const startAt = zonedToUtc(date, from, timeZone);
    const endAt = zonedToUtc(date, to, timeZone);
    if (endAt <= startAt) return setError("End must be after start.");
    if (endAt.getTime() - startAt.getTime() > 8 * 3600_000) return setError("Keep one block under 8 hours.");
    setError(null);
    onSave({ start: startAt.toISOString(), end: endAt.toISOString() });
  };

  const field =
    "h-9 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-ink focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15";

  return (
    <div className="space-y-2.5 bg-surface-2/40 px-3.5 py-3">
      <p className="text-sm font-medium text-ink">{item.title}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-3" htmlFor={`${id}-d`}>
          Date
          <input id={`${id}-d`} type="date" value={date} onChange={(ev) => setDate(ev.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-3" htmlFor={`${id}-s`}>
          Start
          <input id={`${id}-s`} type="time" value={from} onChange={(ev) => setFrom(ev.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-3" htmlFor={`${id}-e`}>
          End
          <input id={`${id}-e`} type="time" value={to} onChange={(ev) => setTo(ev.target.value)} className={field} />
        </label>
      </div>
      <p className="text-[11px] text-ink-3">
        Times are in {timeZone.replace(/_/g, " ")}. Conflicts are checked when you save and again when you approve.
      </p>
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} disabled={busy} className={buttonClasses("ghost", "sm")}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={busy} className={buttonClasses("primary", "sm")}>
          {busy ? "Checking…" : "Use this time"}
        </button>
      </div>
    </div>
  );
}
