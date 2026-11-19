"use client";

import { Button, Card, Dialog, EmptyState, Field, Input, LifeAreaDot, Select } from "@/components/ui";
import { AREA_COLORS, AREA_COLOR_LABELS, LIFE_AREA_NAME_MAX, areaColors } from "@/lib/domain/life-areas";
import type { AreaColor, LifeAreaRecord } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { ArrowDown, ArrowUp, Check, PenLine, Plus, Shapes, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { moveArea, removeLifeArea, saveLifeArea } from "./actions";

type Editing = { area: LifeAreaRecord | null } | null;

export function AreaManager({
  areas,
  usage,
  disabled,
}: {
  areas: LifeAreaRecord[];
  usage: Record<string, number>;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<LifeAreaRecord | null>(null);
  const [moving, startMove] = useTransition();
  const [moveError, setMoveError] = useState<string | null>(null);

  const move = (id: string, dir: "up" | "down") =>
    startMove(async () => {
      setMoveError(null);
      const r = await moveArea(id, dir);
      if (!r.ok) setMoveError(r.error);
    });

  return (
    <Card>
      <div className="flex items-center justify-between gap-4 px-5 pt-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Your areas</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Events, tasks, habits and goals can each belong to one area.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({ area: null })} disabled={disabled}>
          <Plus className="size-3.5" /> New area
        </Button>
      </div>

      <div className="px-5 pb-5 pt-4">
        {moveError && (
          <p role="alert" className="mb-2 text-[13px] text-danger">
            {moveError}
          </p>
        )}
        {areas.length === 0 ? (
          <EmptyState
            icon={Shapes}
            title="No life areas yet"
            description="Create areas like Academics or Sports to color-code your week."
            action={
              <Button size="sm" onClick={() => setEditing({ area: null })} disabled={disabled}>
                <Plus className="size-3.5" /> New area
              </Button>
            }
          />
        ) : (
          <ul className={cn("divide-y divide-border", moving && "opacity-70")}>
            {areas.map((a, i) => {
              const n = usage[a.id] ?? 0;
              return (
                <li key={a.id} className="flex items-center gap-3 py-3">
                  <span
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-lg"
                    style={{ background: areaColors(a).soft }}
                  >
                    <LifeAreaDot area={a} className="size-2.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{a.name}</p>
                    <p className="text-[12px] text-ink-3">
                      {n === 0 ? "Not used yet" : `${n} item${n === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton label={`Move ${a.name} up`} disabled={disabled || moving || i === 0} onClick={() => move(a.id, "up")}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton
                      label={`Move ${a.name} down`}
                      disabled={disabled || moving || i === areas.length - 1}
                      onClick={() => move(a.id, "down")}
                    >
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton label={`Edit ${a.name}`} disabled={disabled} onClick={() => setEditing({ area: a })}>
                      <PenLine className="size-4" />
                    </IconButton>
                    <IconButton label={`Delete ${a.name}`} disabled={disabled} onClick={() => setDeleting(a)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.area ? "Edit life area" : "New life area"}
        size="sm"
      >
        {editing && <AreaForm area={editing.area} onDone={() => setEditing(null)} />}
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete life area" size="sm">
        {deleting && (
          <DeleteForm
            area={deleting}
            others={areas.filter((a) => a.id !== deleting.id)}
            count={usage[deleting.id] ?? 0}
            onDone={() => setDeleting(null)}
          />
        )}
      </Dialog>
    </Card>
  );
}

function IconButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-30"
      {...props}
    >
      {children}
    </button>
  );
}

export function ColorPicker({ value, onChange }: { value: AreaColor; onChange: (c: AreaColor) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
      {AREA_COLORS.map((c) => {
        const on = c === value;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={AREA_COLOR_LABELS[c]}
            title={AREA_COLOR_LABELS[c]}
            onClick={() => onChange(c)}
            className={cn(
              "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-surface transition-shadow",
              on && "ring-2 ring-ink/70",
            )}
            style={{ background: `var(--area-${c})` }}
          >
            {on && <Check className="size-4 text-on-accent" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

function AreaForm({ area, onDone }: { area: LifeAreaRecord | null; onDone: () => void }) {
  const [name, setName] = useState(area?.name ?? "");
  const [color, setColor] = useState<AreaColor>(area?.color ?? "blue");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await saveLifeArea(area?.id ?? null, { name, color });
      if (r.ok) onDone();
      else setError(r.error);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={LIFE_AREA_NAME_MAX}
          placeholder="e.g. Debate, Volunteering"
          required
          data-autofocus
        />
      </Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-ink">Color</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : area ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function DeleteForm({
  area,
  others,
  count,
  onDone,
}: {
  area: LifeAreaRecord;
  others: LifeAreaRecord[];
  count: number;
  onDone: () => void;
}) {
  const [target, setTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      setError(null);
      const r = await removeLifeArea(area.id, target || null);
      if (r.ok) onDone();
      else setError(r.error);
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        {count === 0 ? (
          <>Nothing uses <strong className="font-medium text-ink">{area.name}</strong> yet. It will simply be removed.</>
        ) : (
          <>
            <strong className="font-medium text-ink">{area.name}</strong> has {count} item{count === 1 ? "" : "s"}.
            Nothing will be deleted: choose where they go.
          </>
        )}
      </p>
      {count > 0 && (
        <Field label="Move items to">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Leave uncategorized</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {error && (
          <p role="alert" className="mr-auto text-[13px] text-danger">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={confirm}
          disabled={pending}
          className="bg-danger hover:bg-danger/90"
        >
          {pending ? "Deleting…" : "Delete area"}
        </Button>
      </div>
    </div>
  );
}
