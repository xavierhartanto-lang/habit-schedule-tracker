import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Shared plumbing for the data access modules in this folder.
 * Callers get typed errors they can turn into honest UI states.
 */

/** Supabase env vars are missing, so nothing can be read or saved. */
export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super("Supabase is not configured.");
    this.name = "SupabaseNotConfiguredError";
  }
}

/** Input failed validation before it reached the database. */
export class DataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataValidationError";
  }
}

/** A query failed. `code` is the Postgres / PostgREST error code when known. */
export class DatabaseError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/** The record does not exist, or belongs to someone else (RLS hides it). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

export async function requireDb() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new SupabaseNotConfiguredError();
  return supabase;
}

export function dbError(error: { message: string; code?: string }): DatabaseError {
  return new DatabaseError(error.message, error.code);
}
