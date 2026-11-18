/** What every Phase 3 server action returns to the client. */
export type ActionResult = { ok: true } | { ok: false; error: string };
