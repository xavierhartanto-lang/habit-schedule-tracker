import "server-only";

import { randomUUID } from "node:crypto";

import { sendApprovedEmail } from "@/features/google/server/mail";
import { DataValidationError, SupabaseNotConfiguredError } from "@/lib/db/client";
import { getProfile } from "@/lib/db/profiles";
import { applyPlanItems, getPlan } from "@/lib/db/plans";
import { claimTemplateRun, isMissingTemplates, listRecentRunPlanIds, listTemplates, releaseTemplateRun } from "@/lib/db/templates";
import type { Commitment } from "@/lib/domain/types";
import { dateKeyInZone, isValidTimeZone, timeKeyInZone } from "@/lib/scheduling/zoned";
import {
  draftForTemplate,
  dueOccurrenceKey,
  eventMatches,
  type AutomationReport,
  type AutomationTemplate,
  type TemplateVars,
} from "@/lib/domain/templates";

/**
 * Sends a due automation through Gmail. The same occurrence is claimed once,
 * so a refresh does not send it twice. One-off chat emails are not sent here.
 */

const NONE: AutomationReport = { sent: [], errors: [] };

function prettyDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

function prettyTime(hhmm: string): string {
  const [h, min] = hhmm.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2020, 0, 1, h, min)));
}

async function sendDraft(userId: string, template: AutomationTemplate, occurrenceKey: string, vars: TemplateVars): Promise<AutomationReport> {
  const email = draftForTemplate(template, vars);
  if (!email) return { sent: [], errors: [`${template.title} isn't a valid email, so it wasn't sent.`] };
  const claimed = await claimTemplateRun(userId, template.id, occurrenceKey);
  if (!claimed) return NONE;
  try {
    const sent = await sendApprovedEmail(userId, email);
    return { sent: [`${template.title} to ${sent.to}`], errors: [] };
  } catch (error) {
    await releaseTemplateRun(userId, template.id, occurrenceKey).catch(() => undefined);
    const message = error instanceof DataValidationError ? error.message : "It wasn't sent. Try again in a moment.";
    if (!(error instanceof DataValidationError)) console.error("[automations] send failed", error);
    return { sent: [], errors: [`${template.title}: ${message}`] };
  }
}

/** Older builds left a review card. Send those too, once. */
async function sendWaitingPlans(userId: string): Promise<AutomationReport> {
  const ids = await listRecentRunPlanIds(userId);
  const sent: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const plan = await getPlan(userId, id).catch(() => null);
    if (!plan) continue;
    for (const item of plan.items) {
      if (item.action !== "send_email" || (item.status !== "pending" && item.status !== "conflict" && item.status !== "failed")) continue;
      try {
        const email = await sendApprovedEmail(userId, item.payload);
        await applyPlanItems(userId, plan.id, randomUUID(), [{ item_id: item.id, op: "mark_applied", result_id: null, undo: { op: "none" } }]);
        sent.push(email.subject);
      } catch (error) {
        const message = error instanceof DataValidationError ? error.message : "It wasn't sent. Try again in a moment.";
        if (!(error instanceof DataValidationError)) console.error("[automations] waiting send failed", error);
        errors.push(`${item.title}: ${message}`);
      }
    }
  }
  return { sent, errors };
}

function merge(a: AutomationReport, b: AutomationReport): AutomationReport {
  return { sent: [...a.sent, ...b.sent], errors: [...a.errors, ...b.errors] };
}

function quiet(error: unknown): boolean {
  return error instanceof SupabaseNotConfiguredError || isMissingTemplates(error);
}

/** Sends weekly emails whose slot has passed and that have not already gone out. */
export async function stageDueRecurring(userId: string, now: Date): Promise<AutomationReport> {
  try {
    const waiting = await sendWaitingPlans(userId);
    const [templates, profile] = await Promise.all([listTemplates(userId), getProfile(userId).catch(() => null)]);
    const timeZone = isValidTimeZone(profile?.timezone) ? profile.timezone : "UTC";
    const vars: TemplateVars = {
      student_name: profile?.displayName ?? null,
      grade: profile?.gradeLevel != null ? String(profile.gradeLevel) : null,
    };
    let report = waiting;
    for (const template of templates) {
      if (!template.active || template.schedule.kind !== "weekly") continue;
      const key = dueOccurrenceKey(template.schedule, now, timeZone);
      if (!key) continue;
      report = merge(report, await sendDraft(userId, template, key, { ...vars, event_title: template.title, date: prettyDate(key), time: prettyTime(template.schedule.time) }));
    }
    return report;
  } catch (error) {
    if (quiet(error)) return NONE;
    console.error("[automations] weekly check failed", error);
    return NONE;
  }
}

/** Sends each active automation watching this event's title. Imported Google events are skipped. */
export async function stageForBookedEvent(userId: string, event: Commitment): Promise<AutomationReport> {
  if (event.externalSource === "google" || !event.startsAt) return NONE;
  try {
    const [templates, profile] = await Promise.all([listTemplates(userId), getProfile(userId).catch(() => null)]);
    const timeZone = isValidTimeZone(event.timezone) ? event.timezone : isValidTimeZone(profile?.timezone) ? profile.timezone : "UTC";
    const date = dateKeyInZone(new Date(event.startsAt), timeZone);
    const vars: TemplateVars = {
      student_name: profile?.displayName ?? null,
      grade: profile?.gradeLevel != null ? String(profile.gradeLevel) : null,
      event_title: event.title,
      date: prettyDate(date),
      time: prettyTime(timeKeyInZone(new Date(event.startsAt), timeZone)),
    };
    let report = NONE;
    for (const template of templates) {
      if (!template.active || template.templateType !== "conditional_trigger") continue;
      if (!eventMatches(template.payload.match, event.title)) continue;
      report = merge(report, await sendDraft(userId, template, `event:${event.id}`, vars));
    }
    return report;
  } catch (error) {
    if (quiet(error)) return NONE;
    console.error("[automations] event check failed", error);
    return NONE;
  }
}
