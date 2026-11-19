"use client";

import { Button, Input } from "@/components/ui";
import { defaultBellSchedule, type BellSchedule } from "@/lib/domain/school-schedule";
import { cn } from "@/lib/utils/cn";
import { Bell, Check, Info, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { lookupSchoolBellSchedule, saveSchoolBellSchedule, skipSchoolBellSchedule } from "./actions";
import { BellScheduleEditor } from "./bell-schedule-editor";

type Notice =
  | { kind: "found"; sources: string[]; caveat: string | null; schoolName: string | null }
  | { kind: "missed"; reason: string }
  | { kind: "manual" }
  | { kind: "existing" };

type Step = "ask" | "searching" | "edit";

/**
 * School + bell schedule setup. Asks for the school and district, tries a
 * lookup, then always shows the editable card: pre-filled when a source
 * was found, sensible defaults when not. Nothing saves until Save.
 *
 * `variant="onboarding"` adds "Not now" and refreshes into the chat after
 * saving; `variant="settings"` edits an existing schedule in place.
 */
export function SchoolScheduleSetup({
  variant,
  aiConfigured,
  initialSchool,
  initialDistrict,
  initialSchedule,
}: {
  variant: "onboarding" | "settings";
  aiConfigured: boolean;
  initialSchool: string | null;
  initialDistrict: string | null;
  initialSchedule: BellSchedule | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialSchedule ? "edit" : "ask");
  const [school, setSchool] = useState(initialSchool ?? "");
  const [district, setDistrict] = useState(initialDistrict ?? "");
  const [schedule, setSchedule] = useState<BellSchedule>(initialSchedule ?? defaultBellSchedule());
  const [editorKey, setEditorKey] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(initialSchedule ? { kind: "existing" } : null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const lookupId = useRef(0);

  function openEditor(next: BellSchedule, n: Notice) {
    setSchedule(next);
    setEditorKey((k) => k + 1);
    setNotice(n);
    setStep("edit");
  }

  async function find() {
    setError(null);
    if (school.trim().length < 2) {
      setError("Type your school's name first.");
      return;
    }
    if (!aiConfigured) {
      openEditor(defaultBellSchedule(), { kind: "missed", reason: "Lookup needs the assistant, which isn't set up yet." });
      return;
    }
    const id = ++lookupId.current;
    setStep("searching");
    const res = await lookupSchoolBellSchedule({ school, district });
    if (id !== lookupId.current) return; // user moved on
    if (!res.ok) {
      setStep("ask");
      setError(res.error);
      return;
    }
    const r = res.result;
    if (r.found) {
      openEditor(r.schedule, { kind: "found", sources: r.sources, caveat: r.caveat, schoolName: r.schoolName });
    } else {
      openEditor(defaultBellSchedule(), { kind: "missed", reason: r.reason });
    }
  }

  function manual() {
    lookupId.current++;
    setError(null);
    openEditor(defaultBellSchedule(), { kind: "manual" });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveSchoolBellSchedule({ schedule, school, district, browserTimeZone: browserZone() });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(true);
      if (variant === "onboarding") router.refresh();
    });
  }

  function skip() {
    setError(null);
    lookupId.current++;
    startTransition(async () => {
      const res = await skipSchoolBellSchedule({ school, district });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  const onboarding = variant === "onboarding";

  return (
    <div className={cn("mx-auto w-full max-w-2xl", onboarding && "px-4 py-6 sm:px-6 sm:py-10")}>
      {onboarding && (
        <div className="mb-5 animate-fade-up">
          <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-accent-ink">
            <Bell className="size-3.5" /> Step 1 · Your school
          </p>
          <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink sm:text-[26px]">
            {step === "edit" ? "Here's your school day." : "First, where do you go?"}
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
            {step === "edit"
              ? "Fix anything that's off. School time stays protected, so plans never land in class."
              : "I'll look up your bell schedule so plans never land in class."}{" "}
            <span className="font-medium text-ink">You only do this once.</span>
          </p>
        </div>
      )}

      {step !== "edit" && (
        <div className="animate-fade-up rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (step === "ask") void find();
            }}
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="school-name" className="mb-1.5 block text-[13px] font-medium text-ink">
                  School
                </label>
                <Input
                  id="school-name"
                  value={school}
                  onChange={(e) => setSchool(e.target.value)}
                  placeholder="Lincoln High School"
                  autoComplete="organization"
                  maxLength={120}
                  disabled={step === "searching"}
                />
              </div>
              <div>
                <label htmlFor="school-district" className="mb-1.5 block text-[13px] font-medium text-ink">
                  District or city
                </label>
                <Input
                  id="school-district"
                  value={district}
                  onChange={(e) => setDistrict(e.target.value)}
                  placeholder="Portland Public Schools"
                  maxLength={120}
                  disabled={step === "searching"}
                />
              </div>
            </div>

            {step === "searching" ? (
              <div className="flex flex-col gap-3 rounded-xl bg-surface-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
                <p className="flex items-center gap-2.5 text-[13px] text-ink-2">
                  <span className="flex gap-1" aria-hidden>
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-accent [animation-delay:150ms]" />
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-accent [animation-delay:300ms]" />
                  </span>
                  Checking {school.trim()}&apos;s site for a bell schedule…
                </p>
                <Button type="button" variant="ghost" size="sm" onClick={manual}>
                  Enter it myself
                </Button>
              </div>
            ) : (
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-2">
                  {onboarding && (
                    <Button type="button" variant="ghost" size="md" onClick={skip} disabled={pending}>
                      Not now
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="md" onClick={manual}>
                    Enter it myself
                  </Button>
                </div>
                <Button type="submit" size="md" className="w-full sm:w-auto">
                  <Search className="size-4" /> Find my bell schedule
                </Button>
              </div>
            )}
          </form>
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      {step === "edit" && (
        <div className="animate-fade-up rounded-2xl border border-border bg-surface shadow-card">
          {notice && <NoticeBar notice={notice} school={school} />}
          <div className="p-4 sm:p-5">
            {!onboarding && (
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="school-name-edit" className="mb-1.5 block text-[13px] font-medium text-ink">
                    School
                  </label>
                  <Input id="school-name-edit" value={school} onChange={(e) => setSchool(e.target.value)} maxLength={120} />
                </div>
                <div>
                  <label htmlFor="school-district-edit" className="mb-1.5 block text-[13px] font-medium text-ink">
                    District or city
                  </label>
                  <Input id="school-district-edit" value={district} onChange={(e) => setDistrict(e.target.value)} maxLength={120} />
                </div>
              </div>
            )}
            <BellScheduleEditor
              key={editorKey}
              value={schedule}
              onChange={(s) => {
                setSaved(false);
                setSchedule(s);
              }}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p className="text-[12px] leading-relaxed text-ink-3">
              {onboarding
                ? "One-time setup. Change it anytime in Settings."
                : "Saving replaces your School events on the calendar."}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {onboarding && (
                <Button type="button" variant="ghost" onClick={() => setStep("ask")} disabled={pending}>
                  Back
                </Button>
              )}
              {!onboarding && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setStep("ask");
                  }}
                  disabled={pending}
                >
                  Look it up again
                </Button>
              )}
              <Button type="button" onClick={save} disabled={pending} className="w-full sm:w-auto">
                {pending ? "Saving…" : saved ? (
                  <>
                    <Check className="size-4" /> Saved
                  </>
                ) : (
                  "Save schedule"
                )}
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="px-4 pb-3.5 text-[12px] text-danger sm:px-5">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NoticeBar({ notice, school }: { notice: Notice; school: string }) {
  if (notice.kind === "existing") return null;
  const name = school.trim() || "your school";
  let title: string;
  let body: React.ReactNode;
  if (notice.kind === "found") {
    title = `Found ${notice.schoolName || name}'s schedule. Check it.`;
    body = (
      <>
        Pre-filled from{" "}
        {notice.sources.map((u, i) => (
          <span key={u}>
            {i > 0 && ", "}
            <a href={u} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink underline-offset-2 hover:underline">
              {hostOf(u)}
            </a>
          </span>
        ))}
        . Schedules change, so match it to yours before saving.
        {notice.caveat && <> {notice.caveat}</>}
      </>
    );
  } else if (notice.kind === "missed") {
    title = `Couldn't find a reliable schedule for ${name}.`;
    body = <>{notice.reason} Start from a typical day and adjust. Takes a minute.</>;
  } else {
    title = "Start from a typical day.";
    body = <>Set your classes and period length. Add late-start days if you have them.</>;
  }
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-t-2xl border-b border-border px-4 py-3 sm:px-5",
        notice.kind === "found" ? "bg-accent-soft" : "bg-surface-2",
      )}
    >
      <Info className={cn("mt-0.5 size-4 shrink-0", notice.kind === "found" ? "text-accent-ink" : "text-ink-3")} />
      <div className="min-w-0 text-[13px] leading-relaxed">
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink-2 [overflow-wrap:anywhere]">{body}</p>
      </div>
    </div>
  );
}

function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
