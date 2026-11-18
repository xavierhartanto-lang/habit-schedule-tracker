"use client";

import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { LIFE_AREAS, LIFE_AREA_ORDER } from "@/lib/domain/life-areas";
import { WEEKDAYS, type DataSource, type LifeArea, type Weekday } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { MessageSquareText, PenLine, Plus, Trash2, type LucideIcon } from "lucide-react";
import { useState, useTransition, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { ActionResult } from "./actions";
import { WEEKDAY_LABELS } from "./format";

// ---------- Small shared controls ----------

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={2}
      className={cn(
        "w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20",
        className,
      )}
      {...props}
    />
  );
}

export function AreaOptions({ allowNone }: { allowNone?: boolean }) {
  return (
    <>
      {allowNone && <option value="">No area</option>}
      {LIFE_AREA_ORDER.map((a) => (
        <option key={a} value={a}>{LIFE_AREAS[a].label}</option>
      ))}
    </>
  );
}

export function DayPicker({
  value,
  onChange,
  label,
}: {
  value: Weekday[];
  onChange: (days: Weekday[]) => void;
  label: string;
}) {
  const toggle = (d: Weekday) =>
    onChange(WEEKDAYS.filter((w) => (w === d ? !value.includes(w) : value.includes(w))));
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      <div className="flex gap-1.5">
        {WEEKDAYS.map((d) => {
          const on = value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={WEEKDAY_LABELS[d].short}
              title={WEEKDAY_LABELS[d].short}
              onClick={() => toggle(d)}
              className={cn(
                "grid size-9 place-items-center rounded-lg border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                on
                  ? "border-accent bg-accent-soft text-accent-ink"
                  : "border-border bg-surface text-ink-3 hover:border-border-strong hover:text-ink-2",
              )}
            >
              {WEEKDAY_LABELS[d].letter}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SourceBadge({ source }: { source: DataSource | undefined }) {
  if (source === "conversation") {
    return (
      <Badge tone="accent" className="font-normal">
        <MessageSquareText className="size-3" /> From a chat
      </Badge>
    );
  }
  return (
    <Badge className="font-normal">
      <PenLine className="size-3" /> Added by you
    </Badge>
  );
}

/** Save / cancel row plus the error from the last attempt. */
export function FormFooter({
  pending,
  error,
  onCancel,
  isNew,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  isNew: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      {error && (
        <p role="alert" className="mr-auto text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : isNew ? "Add" : "Save"}
      </Button>
    </div>
  );
}

/** Runs a server action from a form and closes it on success. */
export function useSave(onDone: () => void) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = (action: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (result.ok) onDone();
      else setError(result.error);
    });
  return { pending, error, setError, save };
}

// ---------- Editable section ----------

export type RowView = {
  title: string;
  area: LifeArea | null;
  meta?: string | null;
  details?: string | null;
  badges?: ReactNode;
  source: DataSource | undefined;
};

type Editing = { id: string } | { id: null } | null;

export function EditableList<T extends { id: string }>({
  anchor,
  title,
  description,
  icon: Icon,
  items,
  disabled,
  emptyText,
  addLabel,
  view,
  renderForm,
  onDelete,
}: {
  anchor: string;
  title: string;
  description: string;
  icon: LucideIcon;
  items: T[];
  disabled: boolean;
  emptyText: string;
  addLabel: string;
  view: (item: T) => RowView;
  renderForm: (item: T | null, close: () => void) => ReactNode;
  onDelete: (id: string) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const close = () => setEditing(null);

  const remove = (id: string) =>
    startDelete(async () => {
      setDeleteError(null);
      const result = await onDelete(id);
      if (result.ok) setConfirming(null);
      else setDeleteError(result.error);
    });

  return (
    <Card id={anchor} className="scroll-mt-6">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Icon className="size-4 text-ink-3" strokeWidth={2} />
            {title}
            {items.length > 0 && <span className="text-[13px] font-normal text-ink-3">{items.length}</span>}
          </span>
        }
        description={description}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || editing?.id === null}
            onClick={() => {
              setConfirming(null);
              setEditing({ id: null });
            }}
          >
            <Plus className="size-3.5" /> {addLabel}
          </Button>
        }
      />
      <div className="px-5 pb-3 pt-2">
        {editing?.id === null && (
          <div className="mb-2 mt-2 rounded-xl border border-border bg-surface-2/60 p-3 sm:p-4 animate-fade-up">
            {renderForm(null, close)}
          </div>
        )}

        {items.length === 0 && editing?.id !== null && (
          <p className="py-4 text-[13px] text-ink-3">{emptyText}</p>
        )}

        <ul className="divide-y divide-border">
          {items.map((item) => {
            if (editing?.id === item.id) {
              return (
                <li key={item.id} className="py-3">
                  <div className="rounded-xl border border-border bg-surface-2/60 p-3 sm:p-4 animate-fade-up">
                    {renderForm(item, close)}
                  </div>
                </li>
              );
            }
            const v = view(item);
            const isConfirming = confirming === item.id;
            return (
              <li key={item.id} className="group flex items-start gap-3 py-3.5">
                <span
                  aria-hidden
                  className="mt-[7px] inline-block size-2 shrink-0 rounded-full"
                  style={{ background: v.area ? LIFE_AREAS[v.area].color : "var(--border-strong)" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{v.title}</p>
                  {v.meta && <p className="mt-0.5 text-[13px] text-ink-2">{v.meta}</p>}
                  {v.details && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{v.details}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {v.area && <span className="mr-1 text-[12px] text-ink-3">{LIFE_AREAS[v.area].label}</span>}
                    {v.badges}
                    <SourceBadge source={v.source} />
                  </div>
                  {isConfirming && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 animate-fade-up">
                      <span className="mr-auto text-[13px] text-ink-2">
                        {deleteError ?? "Delete this? The assistant will stop using it."}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={deleting}>
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        className="bg-danger hover:bg-danger/90"
                        onClick={() => remove(item.id)}
                        disabled={deleting}
                      >
                        {deleting ? "Deleting…" : "Delete"}
                      </Button>
                    </div>
                  )}
                </div>
                {!disabled && !isConfirming && (
                  <div className="flex shrink-0 gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`Edit ${v.title}`}
                      onClick={() => {
                        setConfirming(null);
                        setEditing({ id: item.id });
                      }}
                      className="grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <PenLine className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${v.title}`}
                      onClick={() => {
                        setDeleteError(null);
                        setConfirming(item.id);
                      }}
                      className="grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
