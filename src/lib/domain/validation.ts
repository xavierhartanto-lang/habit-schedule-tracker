import { z } from "zod";
import { isDateKey, isValidTimeZone } from "@/lib/scheduling/zoned";
import { isTimeOfDay, isUuid, type ValidationResult } from "./context-items";

/**
 * Shared server-side validation pieces for Phase 3 forms.
 * Every server action validates with these before anything reaches the
 * database, so the database constraints are a second line of defense.
 */

export const zUuid = z.string().refine(isUuid, "Invalid id.");
export const zDateKey = z.string().refine(isDateKey, "Use a valid date.");
export const zTime = z.string().refine(isTimeOfDay, "Use a valid time.");
export const zTimeZone = z.string().refine(isValidTimeZone, "Unknown time zone.");

/** Trimmed text; empty becomes null. */
export function zOptionalText(max: number, label: string) {
  return z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v.trim() : ""))
    .refine((v) => v.length <= max, `${label} is too long (max ${max} characters).`)
    .transform((v) => (v ? v : null));
}

export function zTitle(max: number) {
  return z
    .string({ error: "A title is required." })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .refine((v) => v.length > 0, "A title is required.")
    .refine((v) => v.length <= max, `Keep the title under ${max} characters.`);
}

export const zOptionalAreaId = z
  .union([zUuid, z.literal("")], { error: "Unknown life area." })
  .nullish()
  .transform((v) => v || null);

/** Runs a zod schema and returns the first readable error. */
export function check<T>(schema: z.ZodType<T>, raw: unknown): ValidationResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? "Invalid input." };
}
