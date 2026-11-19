"use client";

import { Button, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { saveAssistantSettings } from "@/features/proactive/actions";
import type { AssistantSettings, ProactivityLevel } from "@/features/proactive/types";
import { cn } from "@/lib/utils/cn";
import { useState, useTransition } from "react";

/**
 * How often the assistant speaks up on its own, and when it stays quiet.
 * Stored with the scheduling preferences (proactive engine owns storage).
 */

const LEVELS: { value: ProactivityLevel; label: string; description: string }[] = [
  { value: "minimal", label: "Minimal", description: "Only urgent things, like an overdue task. At most one at a time." },
  { value: "balanced", label: "Balanced", description: "A daily brief and up to two suggestions when they matter." },
  { value: "proactive", label: "More proactive", description: "Up to three suggestions, including early heads-ups." },
];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function AssistantForm({ settings, disabled }: { settings: AssistantSettings; disabled: boolean }) {
  const [level, setLevel] = useState<ProactivityLevel>(settings.proactivity);
  const [quiet, setQuiet] = useState(settings.quietHoursStart !== null && settings.quietHoursEnd !== null);
  const [start, setStart] = useState(settings.quietHoursStart ?? "22:00");
  const [end, setEnd] = useState(settings.quietHoursEnd ?? "07:00");
  const [status, setStatus] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (quiet && (!TIME.test(start) || !TIME.test(end) || start === end)) {
      setStatus({ error: "Pick a start and end time that differ." });
      return;
    }
    setStatus(null);
    startTransition(async () => {
      const result = await saveAssistantSettings({
        proactivity: level,
        quietHoursStart: quiet ? start : null,
        quietHoursEnd: quiet ? end : null,
      }).catch(() => ({ ok: false as const, error: "Could not save." }));
      setStatus(result.ok ? { ok: true } : { error: result.error });
    });
  };

  return (
    <Card id="assistant">
      <CardHeader title="Assistant" description="How often Whitespace speaks up on its own. It never changes anything without your approval." />
      <CardBody className="space-y-5">
        <fieldset disabled={disabled} className="space-y-5">
          <div role="radiogroup" aria-label="How proactive" className="grid gap-2 sm:grid-cols-3">
            {LEVELS.map((l) => (
              <label
                key={l.value}
                className={cn(
                  "cursor-pointer rounded-xl border px-3.5 py-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
                  level === l.value ? "border-accent/50 bg-accent-soft" : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <input
                  type="radio"
                  name="proactivity"
                  value={l.value}
                  checked={level === l.value}
                  onChange={() => setLevel(l.value)}
                  className="sr-only"
                />
                <span className={cn("block text-sm font-medium", level === l.value ? "text-accent-ink" : "text-ink")}>{l.label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{l.description}</span>
              </label>
            ))}
          </div>

          <div className="border-t border-border pt-4">
            <label className="flex cursor-pointer items-start justify-between gap-6">
              <span>
                <span className="block text-sm font-medium text-ink">Quiet hours</span>
                <span className="mt-0.5 block text-[13px] text-ink-3">No suggestions during this time. Your conversations still work.</span>
              </span>
              <span className="relative mt-0.5 inline-flex shrink-0">
                <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="peer sr-only" />
                <span className="h-5 w-9 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-disabled:opacity-50" />
                <span className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out peer-checked:translate-x-4" />
              </span>
            </label>
            {quiet && (
              <div className="mt-3 grid grid-cols-2 gap-4 sm:max-w-sm">
                <Field label="From">
                  <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="Until">
                  <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                </Field>
              </div>
            )}
          </div>
        </fieldset>
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          {pending ? (
            <span className="text-[13px] text-ink-3">Saving…</span>
          ) : status?.error ? (
            <span className="text-[13px] text-danger">{status.error}</span>
          ) : status?.ok ? (
            <span className="text-[13px] text-success">Saved</span>
          ) : null}
          <Button type="button" size="sm" onClick={save} disabled={disabled || pending}>
            Save assistant settings
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
