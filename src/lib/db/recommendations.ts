import "server-only";

import type {
  ProactivityLevel,
  Recommendation,
  RecommendationAction,
  RecommendationKind,
  RecommendationStatus,
} from "@/features/proactive/types";
import { isUuid } from "@/lib/domain/context-items";
import type { Candidate } from "@/lib/proactive/detect";
import type { LinkedPlanState, ReconcileResult, RecommendationPatch, StoredRecommendation } from "@/lib/proactive/reconcile";
import { raisedRecently } from "@/lib/proactive/surface";
import { NotFoundError, dbError, requireDb } from "./client";
import type { Json, RecommendationRow } from "./database.types";

/**
 * Proactive recommendations (Phase 5). One row per (user, dedupe_key).
 * Every query runs as the signed-in user; RLS limits rows to their own.
 * Nothing here changes calendar events or tasks.
 */

const MAX_ROWS = 500;
const KEEP_RESOLVED_DAYS = 30;

/** The Phase 5 migration hasn't been run yet. */
export function isMissingTable(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "42703" || /recommendations|proactivity|postpone/.test(e.message ?? "") && /does not exist|schema cache/.test(e.message ?? ""));
}

function strings(v: Json): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function actions(v: Json): RecommendationAction[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return [];
    const o = a as Record<string, Json>;
    if (typeof o.id !== "string" || typeof o.kind !== "string" || typeof o.label !== "string") return [];
    const params = o.params && typeof o.params === "object" && !Array.isArray(o.params) ? (o.params as RecommendationAction["params"]) : {};
    return [{ id: o.id, kind: o.kind as RecommendationAction["kind"], label: o.label, params }];
  });
}

export function toStored(row: RecommendationRow): StoredRecommendation {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    status: row.status,
    taskId: row.task_id,
    planId: row.plan_id,
    snoozedUntil: row.snoozed_until,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    priority: row.priority,
    title: row.title,
    reason: row.reason,
    message: row.message,
    facts: strings(row.facts),
    actions: actions(row.actions),
    commitmentIds: row.commitment_ids ?? [],
    date: row.target_date,
  };
}

export function toRecommendation(row: RecommendationRow, level: ProactivityLevel, now: Date): Recommendation {
  return {
    id: row.id,
    kind: row.kind as RecommendationKind,
    priority: row.priority,
    status: row.status,
    title: row.title,
    reason: row.reason,
    message: row.message,
    facts: strings(row.facts),
    target: { taskId: row.task_id, commitmentIds: row.commitment_ids ?? [], date: row.target_date },
    actions: actions(row.actions),
    dedupeKey: row.dedupe_key,
    planId: row.plan_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastShownAt: row.last_shown_at,
    raisedRecently: raisedRecently(row.last_shown_at, level, now),
  };
}

/** Everything except recommendations resolved long ago. Dismissed ones are kept so they never come back. */
export async function listRecommendationRows(userId: string, now = new Date()): Promise<RecommendationRow[]> {
  const supabase = await requireDb();
  const since = new Date(now.getTime() - KEEP_RESOLVED_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("recommendations")
    .select("*")
    .eq("user_id", userId)
    .or(`status.neq.resolved,resolved_at.gte."${since}"`)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw dbError(error);
  return data;
}

export async function getRecommendationRow(userId: string, id: string): Promise<RecommendationRow> {
  if (!isUuid(id)) throw new NotFoundError("Recommendation");
  const supabase = await requireDb();
  const { data, error } = await supabase.from("recommendations").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Recommendation");
  return data;
}

/** Status of each linked plan, for turning "proposed" into acted / dismissed / open. */
export async function linkedPlanStates(userId: string, planIds: string[], now = new Date()): Promise<Map<string, LinkedPlanState>> {
  const out = new Map<string, LinkedPlanState>();
  const ids = [...new Set(planIds)].filter(isUuid);
  if (!ids.length) return out;
  const supabase = await requireDb();
  const { data, error } = await supabase.from("plan_proposals").select("id, status, expires_at").eq("user_id", userId).in("id", ids);
  if (error) throw dbError(error);
  for (const id of ids) out.set(id, "missing");
  for (const p of data) {
    const expired = (p.status === "pending" || p.status === "stale") && Date.parse(p.expires_at) < now.getTime();
    out.set(p.id, expired ? "expired" : p.status);
  }
  return out;
}

function patchColumns(p: RecommendationPatch) {
  const row: Partial<RecommendationRow> = {};
  if (p.status !== undefined) row.status = p.status;
  if (p.priority !== undefined) row.priority = p.priority;
  if (p.title !== undefined) row.title = p.title.slice(0, 300);
  if (p.reason !== undefined) row.reason = p.reason.slice(0, 1000);
  if (p.message !== undefined) row.message = p.message.slice(0, 1000);
  if (p.facts !== undefined) row.facts = p.facts as unknown as Json;
  if (p.actions !== undefined) row.actions = p.actions as unknown as Json;
  if (p.commitmentIds !== undefined) row.commitment_ids = p.commitmentIds.filter(isUuid).slice(0, 20);
  if (p.date !== undefined) row.target_date = p.date;
  if (p.lastSeenAt !== undefined) row.last_seen_at = p.lastSeenAt;
  if (p.resolvedAt !== undefined) row.resolved_at = p.resolvedAt;
  if (p.snoozedUntil !== undefined) row.snoozed_until = p.snoozedUntil;
  if (p.planId !== undefined) row.plan_id = p.planId;
  return row;
}

function insertColumns(userId: string, c: Candidate) {
  return {
    user_id: userId,
    dedupe_key: c.dedupeKey.slice(0, 200),
    kind: c.kind,
    priority: c.priority,
    title: c.title.slice(0, 300),
    reason: c.reason.slice(0, 1000),
    message: c.message.slice(0, 1000),
    facts: c.facts as unknown as Json,
    actions: c.actions as unknown as Json,
    task_id: c.taskId,
    commitment_ids: c.commitmentIds.filter(isUuid).slice(0, 20),
    target_date: c.date,
  };
}

/**
 * Applies a reconcile result and returns the rows it wrote. Concurrent loads
 * (two tabs) can't create duplicates: (user, dedupe_key) is unique.
 * Callers merge these rows in memory instead of listing again: React
 * memoizes identical GET fetches within one render, so a second identical
 * list would return the stale first result.
 */
export async function applyReconcile(userId: string, result: ReconcileResult): Promise<RecommendationRow[]> {
  if (!result.inserts.length && !result.updates.length) return [];
  const supabase = await requireDb();
  const writes: PromiseLike<{ data: RecommendationRow[] | RecommendationRow | null; error: { message: string; code?: string } | null }>[] = [];
  if (result.inserts.length) {
    writes.push(
      supabase
        .from("recommendations")
        .upsert(result.inserts.map((c) => insertColumns(userId, c)), { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
        .select("*"),
    );
  }
  for (const u of result.updates.slice(0, 100)) {
    writes.push(supabase.from("recommendations").update(patchColumns(u.patch)).eq("user_id", userId).eq("id", u.id).select("*"));
  }
  const results = await Promise.all(writes);
  const failed = results.find((r) => r.error);
  if (failed?.error) throw dbError(failed.error);
  const written = results.flatMap((r) => (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []));
  // A concurrent load (second render, another tab) may have inserted some keys first:
  // ignoreDuplicates returns no row for those, so read them back by key.
  const got = new Set(written.map((r) => r.dedupe_key));
  const missing = result.inserts.map((c) => c.dedupeKey.slice(0, 200)).filter((k) => !got.has(k));
  if (missing.length) {
    const { data, error } = await supabase.from("recommendations").select("*").eq("user_id", userId).in("dedupe_key", missing);
    if (error) throw dbError(error);
    written.push(...data);
  }
  return written;
}

export async function updateRecommendation(userId: string, id: string, patch: RecommendationPatch & { status?: RecommendationStatus }): Promise<RecommendationRow> {
  if (!isUuid(id)) throw new NotFoundError("Recommendation");
  const supabase = await requireDb();
  const { data, error } = await supabase
    .from("recommendations")
    .update(patchColumns(patch))
    .eq("user_id", userId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new NotFoundError("Recommendation");
  return data;
}

/** Starts the cooldown for recommendations the UI just raised. */
export async function markShown(userId: string, ids: string[], now = new Date()): Promise<void> {
  const valid = [...new Set(ids)].filter(isUuid).slice(0, 20);
  if (!valid.length) return;
  const supabase = await requireDb();
  const { data, error } = await supabase.from("recommendations").select("id, shown_count").eq("user_id", userId).in("id", valid);
  if (error) throw dbError(error);
  const results = await Promise.all(
    data.map((r) =>
      supabase
        .from("recommendations")
        .update({ last_shown_at: now.toISOString(), shown_count: (r.shown_count ?? 0) + 1 })
        .eq("user_id", userId)
        .eq("id", r.id),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw dbError(failed.error);
}

/** Removes old resolved rows. Dismissed and acted rows are kept: they stop repeats. */
export async function pruneResolved(userId: string, now = new Date()): Promise<void> {
  const supabase = await requireDb();
  const before = new Date(now.getTime() - KEEP_RESOLVED_DAYS * 86_400_000).toISOString();
  const { error } = await supabase.from("recommendations").delete().eq("user_id", userId).eq("status", "resolved").lt("resolved_at", before);
  if (error) throw dbError(error);
}
