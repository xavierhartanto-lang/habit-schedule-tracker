"use client";

import { Button, Card, CardBody, CardHeader, Field, Input, Select, TextArea } from "@/components/ui";
import { WEEKDAY_LABEL, templateSummary, type AutomationReport, type AutomationTemplate } from "@/lib/domain/templates";
import { WEEKDAYS } from "@/lib/domain/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeAutomation, saveAutomation, setAutomationActive } from "./actions";

export function AutomationsBoard({
  templates,
  report,
  disabled,
}: {
  templates: AutomationTemplate[];
  report: AutomationReport;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"recurring_automation" | "conditional_trigger">("recurring_automation");
  const locked = disabled || pending;
  const refresh = () => router.refresh();

  const onCreate = (form: FormData) => {
    setError(null);
    start(async () => {
      const result = await saveAutomation({
        title: form.get("title"),
        templateType: form.get("templateType"),
        weekday: form.get("weekday"),
        time: form.get("time"),
        match: form.get("match"),
        to: form.get("to"),
        subject: form.get("subject"),
        body: form.get("body"),
      });
      if (!result.ok) setError(result.error);
      else refresh();
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "Could not update that automation.");
      else refresh();
    });
  };

  return (
    <div className="space-y-8">
      {report.sent.length > 0 && <p className="text-[13px] text-success">Sent {report.sent.join(", ")}.</p>}
      {report.errors.map((message) => (
        <p key={message} className="text-[13px] text-danger">{message}</p>
      ))}

      <section className="space-y-3">
        {templates.length === 0 ? (
          <p className="text-[13px] text-ink-3">No automations yet. A weekly reminder or an email when an event is booked shows up here.</p>
        ) : (
          templates.map((template) => (
            <Card key={template.id}>
              <CardHeader
                title={template.title}
                description={templateSummary(template)}
                action={
                  <span className="text-[12px] text-ink-3">{template.active ? "On" : "Off"}</span>
                }
              />
              <CardBody className="flex flex-wrap gap-2 pt-0">
                <Button size="sm" variant="secondary" disabled={locked} onClick={() => run(() => setAutomationActive(template.id, !template.active))}>
                  {template.active ? "Turn off" : "Turn on"}
                </Button>
                <Button size="sm" variant="ghost" disabled={locked} onClick={() => run(() => removeAutomation(template.id))}>
                  Remove
                </Button>
              </CardBody>
            </Card>
          ))
        )}
      </section>

      <Card>
        <CardHeader title="New automation" description="Use {student_name}, {grade}, {event_title}, {date}, and {time}. If one of those isn't known, it is sent as written. Turn it off to stop sending." />
        <CardBody>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate(new FormData(e.currentTarget));
            }}
          >
            <Field label="Name">
              <Input name="title" required disabled={locked} placeholder="Science Bowl reminder" />
            </Field>
            <Field label="When">
              <Select name="templateType" value={kind} disabled={locked} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="recurring_automation">Every week</option>
                <option value="conditional_trigger">When an event is booked</option>
              </Select>
            </Field>
            {kind === "recurring_automation" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Day">
                  <Select name="weekday" defaultValue="fr" disabled={locked}>
                    {WEEKDAYS.map((day) => (
                      <option key={day} value={day}>
                        {WEEKDAY_LABEL[day]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Time">
                  <Input name="time" type="time" required defaultValue="18:00" disabled={locked} />
                </Field>
              </div>
            ) : (
              <Field label="Event title contains" hint="For example, tutoring.">
                <Input name="match" required={kind === "conditional_trigger"} disabled={locked} placeholder="tutoring" />
              </Field>
            )}
            <Field label="To">
              <Input name="to" type="email" required disabled={locked} placeholder="office@school.edu" />
            </Field>
            <Field label="Subject">
              <Input name="subject" required disabled={locked} placeholder="Materials for {event_title}" />
            </Field>
            <Field label="Message">
              <TextArea name="body" required rows={5} disabled={locked} placeholder={"Hi,\n\nPlease print materials for {student_name}'s {event_title} on {date} at {time}."} />
            </Field>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <Button type="submit" disabled={locked}>
              {pending ? "Saving…" : "Save automation"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
