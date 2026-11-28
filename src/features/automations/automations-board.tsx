"use client";

import { Button, Card, CardBody, CardHeader, Field, Input, Select, TextArea } from "@/components/ui";
import {
  WEEKDAY_LABEL,
  templateSummary,
  templateVariables,
  type AutomationReport,
  type AutomationTemplate,
  type TemplateType,
} from "@/lib/domain/templates";
import { WEEKDAYS } from "@/lib/domain/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeAutomation, saveAutomation, setAutomationActive } from "./actions";

type RunResult = { ok: boolean; error?: string };

const KIND_HINT: Record<TemplateType, string> = {
  recurring_automation: "Sends by itself every week. Use {student_name}, {grade}, {event_title}, {date}, and {time}. Turn it off to stop sending.",
  conditional_trigger: "Sends by itself when a matching event is booked. Use {student_name}, {grade}, {event_title}, {date}, and {time}. Turn it off to stop sending.",
  email_template:
    "Never sends by itself. Ask in chat, such as “email the office about tutoring”, and Whitespace fills it from that event, then waits for Send. Use {event_title}, {date}, {time}, {location}, or any {name} written as “Name: value” in the event notes, such as {student_name}, {grade}, or {materials}.",
};

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
  const [editing, setEditing] = useState<string | null>(null);
  const locked = disabled || pending;

  const run = (fn: () => Promise<RunResult>, after?: () => void) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "Could not update that automation.");
      else {
        after?.();
        router.refresh();
      }
    });
  };

  const automations = templates.filter((t) => t.templateType !== "email_template");
  const emailTemplates = templates.filter((t) => t.templateType === "email_template");

  const list = (items: AutomationTemplate[], empty: string) =>
    items.length === 0 ? (
      <p className="text-[13px] text-ink-3">{empty}</p>
    ) : (
      items.map((template) =>
        editing === template.id ? (
          <TemplateForm
            key={template.id}
            heading={`Edit ${template.title}`}
            initial={template}
            locked={locked}
            pending={pending}
            error={error}
            onCancel={() => {
              setError(null);
              setEditing(null);
            }}
            onSubmit={(form) => run(() => saveAutomation({ ...form, id: template.id }), () => setEditing(null))}
          />
        ) : (
          <TemplateCard
            key={template.id}
            template={template}
            locked={locked}
            onEdit={() => {
              setError(null);
              setEditing(template.id);
            }}
            onToggle={() => run(() => setAutomationActive(template.id, !template.active))}
            onRemove={() => run(() => removeAutomation(template.id))}
          />
        ),
      )
    );

  return (
    <div className="space-y-8">
      {report.sent.length > 0 && <p className="text-[13px] text-success">Sent {report.sent.join(", ")}.</p>}
      {report.errors.map((message) => (
        <p key={message} className="text-[13px] text-danger">
          {message}
        </p>
      ))}

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium uppercase tracking-wide text-ink-3">Automations</h2>
        {list(automations, "No automations yet. A weekly reminder or an email when an event is booked shows up here.")}
      </section>

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium uppercase tracking-wide text-ink-3">Email templates</h2>
        {list(emailTemplates, "No templates yet. Save one below, then ask in chat to use it. It always waits for you to press Send.")}
      </section>

      {editing === null && error && <p className="text-[13px] text-danger">{error}</p>}

      {editing === null && (
        <TemplateForm
          heading="New automation or template"
          locked={locked}
          pending={pending}
          error={null}
          onSubmit={(form) => run(() => saveAutomation(form))}
        />
      )}
    </div>
  );
}

function TemplateCard({
  template,
  locked,
  onEdit,
  onToggle,
  onRemove,
}: {
  template: AutomationTemplate;
  locked: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const vars = templateVariables(template.payload.subject, template.payload.body);
  return (
    <Card>
      <CardHeader
        title={template.title}
        description={templateSummary(template)}
        action={<span className="text-[12px] text-ink-3">{template.active ? "On" : "Off"}</span>}
      />
      <CardBody className="space-y-3 pt-0">
        {vars.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Placeholders">
            {vars.map((name) => (
              <code key={name} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent">
                {`{${name}}`}
              </code>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={locked} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={onToggle}>
            {template.active ? "Turn off" : "Turn on"}
          </Button>
          <Button size="sm" variant="ghost" disabled={locked} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

type FormValues = Record<string, FormDataEntryValue | null>;

function TemplateForm({
  heading,
  initial,
  locked,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  heading: string;
  initial?: AutomationTemplate;
  locked: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (form: FormValues) => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<TemplateType>(initial?.templateType ?? "email_template");
  const weekly = initial?.schedule.kind === "weekly" ? initial.schedule : null;

  return (
    <Card>
      <CardHeader title={heading} description={KIND_HINT[kind]} />
      <CardBody>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            onSubmit({
              title: form.get("title"),
              templateType: form.get("templateType"),
              weekday: form.get("weekday"),
              time: form.get("time"),
              match: form.get("match"),
              to: form.get("to"),
              subject: form.get("subject"),
              body: form.get("body"),
            });
          }}
        >
          <Field label="Name">
            <Input name="title" required disabled={locked} defaultValue={initial?.title} placeholder="Tutoring print request" />
          </Field>
          <Field label="When">
            <Select name="templateType" value={kind} disabled={locked} onChange={(e) => setKind(e.target.value as TemplateType)}>
              <option value="email_template">Only when I ask in chat (template)</option>
              <option value="recurring_automation">Every week, sends by itself</option>
              <option value="conditional_trigger">When an event is booked, sends by itself</option>
            </Select>
          </Field>
          {kind === "recurring_automation" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Day">
                <Select name="weekday" defaultValue={weekly?.weekday ?? "fr"} disabled={locked}>
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {WEEKDAY_LABEL[day]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Time">
                <Input name="time" type="time" required defaultValue={weekly?.time ?? "18:00"} disabled={locked} />
              </Field>
            </div>
          )}
          {kind === "conditional_trigger" && (
            <Field label="Event title contains" hint="For example, tutoring.">
              <Input name="match" required disabled={locked} defaultValue={initial?.payload.match ?? ""} placeholder="tutoring" />
            </Field>
          )}
          {kind === "email_template" && (
            <Field label="For events containing" hint="Optional. Helps Whitespace pick the right event, such as tutoring.">
              <Input name="match" disabled={locked} defaultValue={initial?.payload.match ?? ""} placeholder="tutoring" />
            </Field>
          )}
          <Field label="To">
            <Input name="to" type="email" required disabled={locked} defaultValue={initial?.payload.to} placeholder="office@school.edu" />
          </Field>
          <Field label="Subject">
            <Input name="subject" required disabled={locked} defaultValue={initial?.payload.subject} placeholder="Print materials for {student_name}" />
          </Field>
          <Field label="Message">
            <TextArea
              name="body"
              required
              rows={6}
              disabled={locked}
              defaultValue={initial?.payload.body}
              placeholder={"Hi,\n\nCould you print {materials} for {student_name} (grade {grade}) before {event_title} on {date} at {time}?\n\nThanks!"}
            />
          </Field>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={locked}>
              {pending ? "Saving…" : initial ? "Save changes" : kind === "email_template" ? "Save template" : "Save automation"}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
