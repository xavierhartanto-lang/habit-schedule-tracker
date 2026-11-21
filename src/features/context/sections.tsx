"use client";

import { Badge, Field, Input, Select } from "@/components/ui";
import { CONTEXT_CATEGORIES, type Commitment, type ContextCategory, type ContextItem, type Goal, type Weekday } from "@/lib/domain/types";
import { cn } from "@/lib/utils/cn";
import { CalendarClock, Lock, Move, Target } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  removeCommitment,
  removeContextItem,
  removeGoal,
  saveCommitment,
  saveContextItem,
  saveGoal,
} from "./actions";
import { CATEGORY_COPY } from "./categories";
import { useLifeAreas } from "./life-areas-context";
import { areaOf } from "@/lib/domain/life-areas";
import { AreaOptions, DayPicker, EditableList, FormFooter, Textarea, useSave } from "./editable-list";
import { commitmentToDraft, describeAttributes, describeCommitment, formatDate, type CommitmentDraft } from "./format";

// ---------- Context items (activities, interests, routines, working times, preferences) ----------

function ContextItemForm({
  item,
  category,
  close,
}: {
  item: ContextItem | null;
  category: ContextCategory;
  close: () => void;
}) {
  const areas = useLifeAreas();
  const a = item?.attributes ?? {};
  const [days, setDays] = useState<Weekday[]>(a.days ?? []);
  const hasTiming = Boolean(a.days?.length || a.startTime || a.endTime || a.timesPerWeek || a.durationMinutes);
  const [showTiming, setShowTiming] = useState(hasTiming || category === "routine" || category === "working_time");
  const { pending, error, save } = useSave(close);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => {
      const v = String(f.get(k) ?? "").trim();
      return v ? Number(v) : undefined;
    };
    const attributes = showTiming
      ? {
          days,
          startTime: f.get("startTime") || undefined,
          endTime: f.get("endTime") || undefined,
          timesPerWeek: num("timesPerWeek"),
          durationMinutes: num("durationMinutes"),
        }
      : {};
    const input = {
      category: f.get("category"),
      title: f.get("title"),
      details: f.get("details"),
      lifeAreaId: f.get("area") || null,
      attributes,
    };
    save(() => saveContextItem(item?.id ?? null, input));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="What is it?">
            <Input
              name="title"
              required
              maxLength={200}
              autoFocus
              defaultValue={item?.title ?? ""}
              placeholder={CATEGORY_COPY[category].placeholder}
            />
          </Field>
        </div>
        <Field label="Type">
          <Select name="category" defaultValue={item?.category ?? category}>
            {CONTEXT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_COPY[c].singular}</option>
            ))}
          </Select>
        </Field>
        <Field label="Life area">
          <Select name="area" defaultValue={item ? (areaOf(areas, item)?.id ?? "") : ""}>
            <AreaOptions />
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Details" hint="Optional. Anything the assistant should keep in mind.">
            <Textarea name="details" maxLength={1000} defaultValue={item?.details ?? ""} />
          </Field>
        </div>
      </div>

      {showTiming ? (
        <div className="space-y-4 rounded-lg border border-border bg-surface p-3 sm:p-3.5">
          <DayPicker label="Days" value={days} onChange={setDays} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="From">
              <Input type="time" className="px-2.5" name="startTime" defaultValue={a.startTime ?? ""} />
            </Field>
            <Field label="Until">
              <Input type="time" className="px-2.5" name="endTime" defaultValue={a.endTime ?? ""} />
            </Field>
            <Field label="Times a week">
              <Input type="number" name="timesPerWeek" min={1} max={21} defaultValue={a.timesPerWeek ?? ""} />
            </Field>
            <Field label="Minutes">
              <Input type="number" name="durationMinutes" min={1} max={1440} defaultValue={a.durationMinutes ?? ""} />
            </Field>
          </div>
          <button
            type="button"
            onClick={() => setShowTiming(false)}
            className="text-[12px] font-medium text-ink-3 hover:text-ink-2"
          >
            Remove timing
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowTiming(true)}
          className="text-[13px] font-medium text-accent-ink hover:underline"
        >
          + Add days or times
        </button>
      )}

      <FormFooter pending={pending} error={error} onCancel={close} isNew={!item} />
    </form>
  );
}

export function ContextItemSection({
  category,
  items,
  disabled,
}: {
  category: ContextCategory;
  items: ContextItem[];
  disabled: boolean;
}) {
  const copy = CATEGORY_COPY[category];
  return (
    <EditableList
      anchor={copy.anchor}
      title={copy.title}
      description={copy.description}
      icon={copy.icon}
      items={items}
      disabled={disabled}
      emptyText={copy.empty}
      addLabel="Add"
      view={(i) => ({
        title: i.title,
        area: i,
        meta: describeAttributes(i.attributes),
        details: i.details,
        source: i.source,
      })}
      renderForm={(item, close) => <ContextItemForm item={item} category={category} close={close} />}
      onDelete={removeContextItem}
    />
  );
}

// ---------- Commitments ----------

const EMPTY_COMMITMENT: CommitmentDraft = {
  title: "",
  lifeAreaId: "",
  kind: "fixed",
  days: [],
  date: "",
  startTime: "",
  endTime: "",
  estimatedMinutes: "",
  dueDate: "",
  location: "",
  notes: "",
};

function CommitmentForm({
  item,
  timeZone,
  close,
}: {
  item: Commitment | null;
  timeZone: string;
  close: () => void;
}) {
  const [draft, setDraft] = useState<CommitmentDraft>(() =>
    item ? commitmentToDraft(item, timeZone) : EMPTY_COMMITMENT,
  );
  const set = <K extends keyof CommitmentDraft>(key: K, value: CommitmentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const { pending, error, save } = useSave(close);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save(() => saveCommitment(item?.id ?? null, draft));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="What is it?">
            <Input
              required
              maxLength={200}
              autoFocus
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="AP Chem, swim practice, shift at the library"
            />
          </Field>
        </div>
        <Field label="Life area">
          <Select value={draft.lifeAreaId} onChange={(e) => set("lifeAreaId", e.target.value)}>
            <AreaOptions />
          </Select>
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink">Kind</span>
          <div role="radiogroup" aria-label="Kind" className="grid h-10 grid-cols-2 rounded-lg border border-border bg-surface p-0.5">
            {(
              [
                { value: "fixed", label: "Set time", icon: Lock },
                { value: "flexible", label: "Flexible", icon: Move },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.kind === value}
                onClick={() => set("kind", value)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors",
                  draft.kind === value ? "bg-accent-soft text-accent-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {draft.kind === "fixed" ? (
        <div className="space-y-4 rounded-lg border border-border bg-surface p-3 sm:p-3.5">
          <DayPicker label="Repeats on" value={draft.days} onChange={(days) => set("days", days)} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Starts">
              <Input type="time" className="px-2.5" required value={draft.startTime} onChange={(e) => set("startTime", e.target.value)} />
            </Field>
            <Field label="Ends">
              <Input type="time" className="px-2.5" required value={draft.endTime} onChange={(e) => set("endTime", e.target.value)} />
            </Field>
          </div>
          <p className="text-[12px] text-ink-3">
            Times are in {timeZone.replaceAll("_", " ")}. One-time events belong on your Calendar.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface p-3 sm:p-3.5">
          <Field label="Time needed (min)">
            <Input
              type="number"
              min={1}
              value={draft.estimatedMinutes}
              onChange={(e) => set("estimatedMinutes", e.target.value)}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location">
          <Input maxLength={200} value={draft.location} onChange={(e) => set("location", e.target.value)} placeholder="Optional" />
        </Field>
        <Field label="Notes">
          <Input maxLength={1000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Optional" />
        </Field>
      </div>

      <FormFooter pending={pending} error={error} onCancel={close} isNew={!item} />
    </form>
  );
}

export function CommitmentSection({
  items,
  timeZone,
  disabled,
}: {
  items: Commitment[];
  timeZone: string;
  disabled: boolean;
}) {
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "fixed" ? -1 : 1));
  return (
    <EditableList
      anchor="commitments"
      title="Commitments"
      description="Classes, practice, shifts and other things that repeat every week. To-dos live in Tasks."
      icon={CalendarClock}
      items={sorted}
      disabled={disabled}
      emptyText="No commitments yet. Tell the assistant your weekly schedule, or add one here."
      addLabel="Add"
      view={(c) => ({
        title: c.title,
        area: c,
        meta: [describeCommitment(c, timeZone), c.location].filter(Boolean).join(" · ") || null,
        details: c.notes,
        source: c.source,
        badges:
          c.kind === "fixed" ? (
            <Badge className="font-normal"><Lock className="size-3" /> Set time</Badge>
          ) : (
            <Badge className="border border-dashed border-border-strong bg-transparent font-normal">
              <Move className="size-3" /> Flexible
            </Badge>
          ),
      })}
      renderForm={(item, close) => <CommitmentForm item={item} timeZone={timeZone} close={close} />}
      onDelete={removeCommitment}
    />
  );
}

// ---------- Goals ----------

const HORIZON_LABEL = { short_term: "Short term", long_term: "Long term" } as const;
const STATUS_LABEL = { active: "Active", paused: "Paused", completed: "Done" } as const;

function GoalForm({ item, close }: { item: Goal | null; close: () => void }) {
  const areas = useLifeAreas();
  const { pending, error, save } = useSave(close);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input = {
      title: f.get("title"),
      lifeAreaId: f.get("area") || null,
      horizon: f.get("horizon") || null,
      status: f.get("status"),
      targetDate: f.get("targetDate") || null,
      description: f.get("description"),
    };
    save(() => saveGoal(item?.id ?? null, input));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Goal">
            <Input
              name="title"
              required
              maxLength={200}
              autoFocus
              defaultValue={item?.title ?? ""}
              placeholder="Get a 5 on AP Bio, make varsity, finish my portfolio"
            />
          </Field>
        </div>
        <Field label="Life area">
          <Select name="area" defaultValue={item ? (areaOf(areas, item)?.id ?? "") : ""}>
            <AreaOptions />
          </Select>
        </Field>
        <Field label="Horizon">
          <Select name="horizon" defaultValue={item?.horizon ?? ""}>
            <option value="">Not set</option>
            <option value="short_term">Short term (weeks to months)</option>
            <option value="long_term">Long term (a year or more)</option>
          </Select>
        </Field>
        <Field label="Target date">
          <Input type="date" name="targetDate" defaultValue={item?.targetDate ?? ""} />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={item?.status ?? "active"}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Done</option>
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Why it matters" hint="Optional.">
            <Textarea name="description" maxLength={2000} defaultValue={item?.description ?? ""} />
          </Field>
        </div>
      </div>
      <FormFooter pending={pending} error={error} onCancel={close} isNew={!item} />
    </form>
  );
}

export function GoalSection({ items, disabled }: { items: Goal[]; disabled: boolean }) {
  return (
    <EditableList
      anchor="goals"
      title="Goals"
      description="What you are working toward, now and later."
      icon={Target}
      items={items}
      disabled={disabled}
      emptyText="No goals yet. Share one with the assistant, or add it here."
      addLabel="Add"
      view={(g) => ({
        title: g.title,
        area: g,
        meta: g.targetDate ? `By ${formatDate(g.targetDate)}` : null,
        details: g.description,
        source: g.source,
        badges: (
          <>
            {g.horizon && <Badge className="font-normal">{HORIZON_LABEL[g.horizon]}</Badge>}
            {g.status !== "active" && <Badge className="font-normal">{STATUS_LABEL[g.status]}</Badge>}
          </>
        ),
      })}
      renderForm={(item, close) => <GoalForm item={item} close={close} />}
      onDelete={removeGoal}
    />
  );
}
