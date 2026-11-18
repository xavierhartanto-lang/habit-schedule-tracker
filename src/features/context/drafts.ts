import { weeklyScheduleToCommitmentTimes } from "@/lib/domain/commitments";
import { isTimeOfDay } from "@/lib/domain/context-items";
import type { Commitment } from "@/lib/domain/types";
import { commitmentToDraft, fromZoned, type CommitmentDraft } from "./format";

/**
 * Turns the edit form's draft into the input lib/db validates.
 * Returns a friendly error instead of guessing when something is missing.
 */
export function draftToCommitmentInput(
  draft: CommitmentDraft,
  timeZone: string,
  existing?: Commitment | null,
  now: Date = new Date(),
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const base = {
    title: draft.title,
    lifeAreaId: draft.lifeAreaId || null,
    kind: draft.kind,
    location: draft.location,
    notes: draft.notes,
  };

  if (draft.kind === "flexible") {
    const minutes = draft.estimatedMinutes.trim() ? Number(draft.estimatedMinutes) : null;
    if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0)) {
      return { ok: false, error: "Time needed must be a whole number of minutes." };
    }
    return {
      ok: true,
      value: {
        ...base,
        startsAt: null,
        endsAt: null,
        recurrenceRule: null,
        estimatedMinutes: minutes,
        dueAt: draft.dueDate ? fromZoned(draft.dueDate, "23:59", timeZone) : null,
      },
    };
  }

  if (!isTimeOfDay(draft.startTime) || !isTimeOfDay(draft.endTime)) {
    return { ok: false, error: "Add a start and end time." };
  }
  if (draft.endTime <= draft.startTime) return { ok: false, error: "End time must be after start time." };

  const flexibleFields = { estimatedMinutes: null, dueAt: null };

  if (draft.days.length) {
    // Unchanged schedule: keep the original first occurrence.
    if (existing?.kind === "fixed") {
      const before = commitmentToDraft(existing, timeZone);
      const same =
        before.days.join() === draft.days.join() &&
        before.startTime === draft.startTime &&
        before.endTime === draft.endTime &&
        existing.startsAt &&
        existing.endsAt &&
        existing.recurrenceRule;
      if (same) {
        return {
          ok: true,
          value: {
            ...base,
            ...flexibleFields,
            startsAt: existing.startsAt,
            endsAt: existing.endsAt,
            recurrenceRule: existing.recurrenceRule,
          },
        };
      }
    }
    const times = weeklyScheduleToCommitmentTimes(
      { days: draft.days, startTime: draft.startTime, endTime: draft.endTime },
      timeZone,
      now,
    );
    if (!times) return { ok: false, error: "Could not work out that weekly schedule. Check the days and times." };
    return { ok: true, value: { ...base, ...flexibleFields, ...times } };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    return { ok: false, error: "Pick the days it repeats, or a date for a one-time event." };
  }
  return {
    ok: true,
    value: {
      ...base,
      ...flexibleFields,
      startsAt: fromZoned(draft.date, draft.startTime, timeZone),
      endsAt: fromZoned(draft.date, draft.endTime, timeZone),
      recurrenceRule: null,
    },
  };
}
