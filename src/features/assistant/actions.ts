"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { normalizeText } from "@/lib/ai/extraction";
import { getSessionUser } from "@/lib/auth/session";
import { DataValidationError } from "@/lib/db/client";
import { createCommitment, listCommitments, updateCommitment } from "@/lib/db/commitments";
import { createContextItem, listContextItems, updateContextItem } from "@/lib/db/context-items";
import { deleteConversation as deleteConversationRow } from "@/lib/db/conversations";
import { createGoal, listGoals, updateGoal } from "@/lib/db/goals";
import { getMessage, updateMessageMetadata } from "@/lib/db/messages";
import { getProfile, markOnboarded } from "@/lib/db/profiles";
import type { ContextCategory, MessageMetadata } from "@/lib/domain/types";
import { applyProposalEdit, needsSchedule, proposalToWrite, type ProposalEdit, type ProposalWrite } from "./proposal-input";
import { readUserMessageMeta, type Proposal } from "./types";

/**
 * Server actions behind the proposal cards and conversation controls.
 *
 * Proposals are read back from the database, never taken from the client,
 * so the user can only confirm facts the AI actually proposed (plus their
 * own edits, which are validated again here).
 */

export type ProposalActionResult =
  | { ok: true; proposals: Proposal[]; skipped?: number }
  | { ok: false; error: string; proposals?: Proposal[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function friendly(error: unknown): string {
  if (error instanceof DataValidationError) return error.message;
  if (error instanceof Error && error.name === "SupabaseNotConfiguredError") return "Saving isn't available until Supabase is configured.";
  console.error("[assistant] action failed", error);
  return "Couldn't save that. Try again.";
}

async function loadProposals(userId: string, messageId: string) {
  if (!UUID_RE.test(messageId)) return null;
  const message = await getMessage(userId, messageId);
  if (!message || message.role !== "user") return null;
  return { message, meta: readUserMessageMeta(message.metadata) };
}

async function storeProposals(userId: string, messageId: string, metadata: MessageMetadata, proposals: Proposal[]) {
  await updateMessageMetadata(userId, messageId, { ...metadata, proposals } as unknown as MessageMetadata);
}

/** Saves one confirmed proposal. Updates the fact it replaces when the AI said so. */
async function writeProposal(userId: string, write: ProposalWrite, supersedes: string | null) {
  const target = supersedes ? normalizeText(supersedes) : null;
  const matches = (title: string) => target !== null && normalizeText(title) === target;

  if (write.table === "commitments") {
    if (target) {
      const existing = (await listCommitments(userId)).find((c) => matches(c.title));
      if (existing) return { id: (await updateCommitment(userId, existing.id, write.input)).id, updated: true };
    }
    return { id: (await createCommitment(userId, write.input)).id, updated: false };
  }
  if (write.table === "goals") {
    if (target) {
      const existing = (await listGoals(userId)).find((g) => matches(g.title));
      if (existing) return { id: (await updateGoal(userId, existing.id, write.input)).id, updated: true };
    }
    return { id: (await createGoal(userId, write.input)).id, updated: false };
  }
  if (target) {
    const category = write.input.category as ContextCategory;
    const existing = (await listContextItems(userId, { category })).find((i) => matches(i.title));
    if (existing) {
      const { title, details, area, attributes } = write.input;
      return { id: (await updateContextItem(userId, existing.id, { title, details, area, attributes })).id, updated: true };
    }
  }
  return { id: (await createContextItem(userId, write.input)).id, updated: false };
}

async function confirm(
  userId: string,
  timezone: string,
  messageId: string,
  proposal: Proposal,
  edit: ProposalEdit | null,
): Promise<{ ok: true; proposal: Proposal } | { ok: false; error: string }> {
  const edited = applyProposalEdit(proposal.item, edit);
  if (!edited.ok) return edited;
  const mapped = proposalToWrite(edited.item, { timezone, sourceMessageId: messageId });
  if (!mapped.ok) return mapped;
  const saved = await writeProposal(userId, mapped.write, edited.item.supersedes);
  return {
    ok: true,
    proposal: { ...proposal, item: edited.item, status: "saved", saved: { table: mapped.write.table, ...saved } },
  };
}

function revalidateChat() {
  revalidatePath("/onboarding");
  revalidatePath("/assistant", "layout");
}

export async function saveProposal(input: {
  messageId: string;
  proposalId: string;
  edit?: ProposalEdit | null;
}): Promise<ProposalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to save." };

  try {
    const loaded = await loadProposals(user.id, input.messageId);
    if (!loaded) return { ok: false, error: "That suggestion wasn't found." };
    const { message, meta } = loaded;
    const proposal = meta.proposals.find((p) => p.id === input.proposalId);
    if (!proposal) return { ok: false, error: "That suggestion wasn't found." };
    if (proposal.status === "saved") return { ok: true, proposals: meta.proposals };

    const profile = await getProfile(user.id);
    const result = await confirm(user.id, profile?.timezone ?? "UTC", message.id, proposal, input.edit ?? null);
    if (!result.ok) return { ok: false, error: result.error, proposals: meta.proposals };

    const proposals = meta.proposals.map((p) => (p.id === proposal.id ? result.proposal : p));
    await storeProposals(user.id, message.id, message.metadata, proposals);
    revalidateChat();
    return { ok: true, proposals };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/** Saves every pending proposal that is ready. Ones that need details are left for the user. */
export async function saveAllProposals(input: { messageId: string }): Promise<ProposalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in to save." };

  try {
    const loaded = await loadProposals(user.id, input.messageId);
    if (!loaded) return { ok: false, error: "Those suggestions weren't found." };
    const { message, meta } = loaded;
    const profile = await getProfile(user.id);
    const timezone = profile?.timezone ?? "UTC";

    const proposals = [...meta.proposals];
    let skipped = 0;
    let failure: string | null = null;
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      if (p.status !== "pending") continue;
      if (needsSchedule(p.item)) {
        skipped++;
        continue;
      }
      try {
        const result = await confirm(user.id, timezone, message.id, p, null);
        if (result.ok) proposals[i] = result.proposal;
        else skipped++;
      } catch (error) {
        failure = friendly(error);
        break;
      }
    }

    await storeProposals(user.id, message.id, message.metadata, proposals);
    revalidateChat();
    return failure ? { ok: false, error: failure, proposals } : { ok: true, proposals, skipped };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/** Dismiss a proposal, or bring a dismissed one back. Saved ones stay saved. */
export async function setProposalDismissed(input: {
  messageId: string;
  proposalId: string;
  dismissed: boolean;
}): Promise<ProposalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in first." };

  try {
    const loaded = await loadProposals(user.id, input.messageId);
    if (!loaded) return { ok: false, error: "That suggestion wasn't found." };
    const { message, meta } = loaded;
    const proposals = meta.proposals.map((p) =>
      p.id === input.proposalId && p.status !== "saved"
        ? { ...p, status: input.dismissed ? ("dismissed" as const) : ("pending" as const) }
        : p,
    );
    await storeProposals(user.id, message.id, message.metadata, proposals);
    return { ok: true, proposals };
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
}

/** Deletes a conversation and its messages. Facts the user saved from it are kept. */
export async function deleteConversation(input: { conversationId: string }): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Sign in first." };
  if (!UUID_RE.test(input.conversationId)) return { ok: false, error: "Conversation not found." };
  try {
    await deleteConversationRow(user.id, input.conversationId);
  } catch (error) {
    return { ok: false, error: friendly(error) };
  }
  revalidatePath("/assistant", "layout");
  return { ok: true };
}

/** Ends onboarding (finished or skipped). The user can come back to it anytime. */
export async function finishOnboarding(): Promise<{ error: string } | void> {
  const user = await getSessionUser();
  if (!user) return { error: "Sign in first." };
  try {
    await markOnboarded(user.id);
  } catch (error) {
    return { error: friendly(error) };
  }
  revalidatePath("/", "layout");
  redirect("/");
}
