"use server";

import { isUuid } from "@/lib/domain/context-items";
import { isWeekday, validateTemplate, type TemplateType } from "@/lib/domain/templates";
import { DataValidationError, NotFoundError } from "@/lib/db/client";
import { deleteTemplate, insertTemplate, setTemplateActive } from "@/lib/db/templates";
import type { ActionResult } from "@/features/shared/action-result";
import { runAction } from "@/features/shared/run-action";

const PATHS = ["/", "/automations", "/assistant"];

export async function saveAutomation(form: unknown): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!form || typeof form !== "object") throw new DataValidationError("That automation is incomplete.");
    const raw = form as Record<string, unknown>;
    const templateType: TemplateType = raw.templateType === "conditional_trigger" ? "conditional_trigger" : "recurring_automation";
    const checked = validateTemplate({
      title: String(raw.title ?? ""),
      templateType,
      schedule:
        templateType === "recurring_automation"
          ? { kind: "weekly", weekday: isWeekday(raw.weekday) ? raw.weekday : "fr", time: String(raw.time ?? "") }
          : { kind: "event" },
      payload: {
        to: String(raw.to ?? ""),
        subject: String(raw.subject ?? raw.title ?? ""),
        body: String(raw.body ?? ""),
        match: templateType === "conditional_trigger" ? String(raw.match ?? "") : null,
      },
    });
    if (!checked.ok) throw new DataValidationError(checked.error);
    await insertTemplate(userId, checked.value);
  });
}

export async function setAutomationActive(id: string, active: boolean): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!isUuid(id) || typeof active !== "boolean") throw new NotFoundError("Automation");
    await setTemplateActive(userId, id, active);
  });
}

export async function removeAutomation(id: string): Promise<ActionResult> {
  return runAction(PATHS, async (userId) => {
    if (!isUuid(id)) throw new NotFoundError("Automation");
    await deleteTemplate(userId, id);
  });
}
