import type { RecommendationStatus } from "@/features/proactive/types";
import type { Candidate } from "./detect";

/**
 * Keeps stored recommendations in step with what the detectors find now,
 * without duplicates and without nagging. Pure: returns the writes to make.
 *
 *   new situation                -> insert (open)
 *   still true, open             -> refresh text/facts if they changed
 *   still true, snooze over      -> reopen
 *   no longer true, open/snoozed -> resolved
 *   dismissed                    -> stays dismissed for that dedupe key (never resurfaces)
 *   proposed (turned into plan)  -> acted when the plan was applied, dismissed when the
 *                                   user rejected it, open again if the plan expired or vanished
 *   acted                        -> stays acted; a changed situation has a new key
 *   resolved but true again      -> reopened
 *
 * A task the user waved away ("not relevant") isn't nagged about for
 * DEPRIORITIZED_DAYS through other kinds either, unless it is high priority.
 */

export const DEPRIORITIZED_DAYS = 14;
/** Don't rewrite last_seen_at more often than this. */
const SEEN_REFRESH_MS = 6 * 3_600_000;

export type StoredRecommendation = {
  id: string;
  dedupeKey: string;
  status: RecommendationStatus;
  taskId: string | null;
  planId: string | null;
  snoozedUntil: string | null;
  updatedAt: string;
  lastSeenAt: string;
  priority: Candidate["priority"];
  title: string;
  reason: string;
  message: string;
  facts: string[];
  actions: Candidate["actions"];
  commitmentIds: string[];
  date: string | null;
};

/** Status of a linked plan: a PlanStatus, "expired" (pending but past its expiry) or "missing". */
export type LinkedPlanState = "pending" | "partially_applied" | "applied" | "rejected" | "stale" | "expired" | "missing";

export type RecommendationPatch = Partial<{
  status: RecommendationStatus;
  priority: Candidate["priority"];
  title: string;
  reason: string;
  message: string;
  facts: string[];
  actions: Candidate["actions"];
  commitmentIds: string[];
  date: string | null;
  lastSeenAt: string;
  resolvedAt: string | null;
  snoozedUntil: string | null;
  planId: string | null;
}>;

export type ReconcileResult = {
  inserts: Candidate[];
  updates: { id: string; patch: RecommendationPatch }[];
};

function contentChanged(row: StoredRecommendation, c: Candidate): boolean {
  return (
    row.priority !== c.priority ||
    row.title !== c.title ||
    row.reason !== c.reason ||
    row.message !== c.message ||
    row.date !== c.date ||
    JSON.stringify(row.facts) !== JSON.stringify(c.facts) ||
    JSON.stringify(row.actions) !== JSON.stringify(c.actions) ||
    JSON.stringify(row.commitmentIds) !== JSON.stringify(c.commitmentIds)
  );
}

function content(c: Candidate): RecommendationPatch {
  return {
    priority: c.priority,
    title: c.title,
    reason: c.reason,
    message: c.message,
    facts: c.facts,
    actions: c.actions,
    commitmentIds: c.commitmentIds,
    date: c.date,
  };
}

function fromPlan(state: LinkedPlanState | undefined): RecommendationStatus | null {
  switch (state) {
    case "applied":
    case "partially_applied":
      return "acted";
    case "rejected":
      return "dismissed";
    case "expired":
    case "missing":
    case undefined:
      return "open";
    default:
      return null; // still waiting on the user
  }
}

export function reconcile(input: {
  stored: StoredRecommendation[];
  candidates: Candidate[];
  plans: Map<string, LinkedPlanState>;
  now: Date;
}): ReconcileResult {
  const now = input.now;
  const nowIso = now.toISOString();
  const byKey = new Map(input.stored.map((r) => [r.dedupeKey, r]));
  const current = new Set(input.candidates.map((c) => c.dedupeKey));
  const updates: ReconcileResult["updates"] = [];
  const inserts: Candidate[] = [];

  const waivedTasks = new Set(
    input.stored
      .filter(
        (r) =>
          r.status === "dismissed" &&
          r.taskId &&
          !r.snoozedUntil &&
          now.getTime() - Date.parse(r.updatedAt) < DEPRIORITIZED_DAYS * 86_400_000,
      )
      .map((r) => r.taskId!),
  );

  for (const c of input.candidates) {
    const row = byKey.get(c.dedupeKey);
    if (!row) {
      if (c.taskId && waivedTasks.has(c.taskId) && c.priority !== "high") continue;
      inserts.push(c);
      continue;
    }
    const seen = now.getTime() - Date.parse(row.lastSeenAt) > SEEN_REFRESH_MS ? { lastSeenAt: nowIso } : {};
    switch (row.status) {
      case "open":
        if (contentChanged(row, c)) updates.push({ id: row.id, patch: { ...content(c), lastSeenAt: nowIso } });
        else if (seen.lastSeenAt) updates.push({ id: row.id, patch: seen });
        break;
      case "snoozed":
        if (!row.snoozedUntil || Date.parse(row.snoozedUntil) <= now.getTime()) {
          updates.push({ id: row.id, patch: { ...content(c), status: "open", snoozedUntil: null, lastSeenAt: nowIso } });
        } else if (seen.lastSeenAt) {
          updates.push({ id: row.id, patch: seen });
        }
        break;
      case "resolved":
        updates.push({ id: row.id, patch: { ...content(c), status: "open", resolvedAt: null, lastSeenAt: nowIso } });
        break;
      case "proposed": {
        const next = fromPlan(row.planId ? input.plans.get(row.planId) : "missing");
        if (next === "open") updates.push({ id: row.id, patch: { ...content(c), status: "open", planId: null, lastSeenAt: nowIso } });
        else if (next) updates.push({ id: row.id, patch: { status: next, lastSeenAt: nowIso } });
        break;
      }
      case "dismissed":
      case "acted":
        if (seen.lastSeenAt) updates.push({ id: row.id, patch: seen });
        break;
    }
  }

  for (const row of input.stored) {
    if (current.has(row.dedupeKey)) continue;
    if (row.status === "open" || row.status === "snoozed") {
      updates.push({ id: row.id, patch: { status: "resolved", resolvedAt: nowIso } });
    } else if (row.status === "proposed") {
      const next = fromPlan(row.planId ? input.plans.get(row.planId) : "missing");
      // The situation went away while a plan was pending: done if applied, otherwise just resolved.
      if (next === "acted" || next === "dismissed") updates.push({ id: row.id, patch: { status: next } });
      else if (next === "open") updates.push({ id: row.id, patch: { status: "resolved", resolvedAt: nowIso, planId: null } });
    }
  }

  return { inserts, updates };
}
