import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { findAddressedInteraction, hasConsumedAddressedInteractionWake, hasAddressedOwnerDispositionRun } from "../repositories/addressed-interactions.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

export function isAddressedInteractionWakeContext(context: Record<string, unknown>): boolean {
  return context.wakeReason === "interaction_pending" && context.source === "issue.interaction.created";
}

/** An attention request is authority to answer its card, not task ownership.
 * Read current persisted scope and audience; never trust a wake flag alone.
 * Dispatch callers hold the issue lock, as interaction mutations do.
 */
type AddressedInteraction = NonNullable<Awaited<ReturnType<typeof findAddressedInteraction>>>;
export type AddressedInteractionContext = Pick<AddressedInteraction, "id" | "kind" | "title" | "summary" | "sourceRunId" | "payload">;
type AddressedWakeInput = {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>;
  excludeRequestId?: string | null;
  requireSettledDecision?: boolean;
  /** A blocked-task attention exception cannot be manufactured by its worker. */
  excludeTaskOwnerAndCreator?: boolean;
  allowTaskOwnerFromBlockingSource?: boolean;
};

async function readAddressedWake(db: Db, input: AddressedWakeInput): Promise<{ state: "pending"; interaction: AddressedInteraction } | { state: "stale" } | null> {
  const context = input.contextSnapshot;
  if (!isAddressedInteractionWakeContext(context)) return null;
  const id = z.string().guid().safeParse(context.interactionId);
  if (!id.success) return { state: "stale" };
  const row = await findAddressedInteraction(db, { ...input, interactionId: id.data });
  if (!row || row.status !== "pending" || row.addresseeUserId ||
      !["ask_user_questions", "request_confirmation"].includes(row.kind) ||
      context.interactionKind !== row.kind || !row.payload || typeof row.payload !== "object") return { state: "stale" };
  const governed = row.kind === "request_confirmation" &&
    ("toolAction" in row.payload || "secretProposal" in row.payload || "connectionAuthorization" in row.payload);
  return issueThreadInteractionAttentionAgentAllowed({
    agentId: input.agentId, interaction: row, governedAction: governed,
  }) ? { state: "pending", interaction: row } : { state: "stale" };
}

export async function addressedInteractionWakeState(db: Db, input: AddressedWakeInput): Promise<"pending" | "stale" | null> {
  return (await readAddressedWake(db, input))?.state ?? null;
}

export async function addressedInteractionWakeContext(db: Db, input: AddressedWakeInput): Promise<AddressedInteractionContext | null> {
  const read = await readAddressedWake(db, input);
  if (read?.state !== "pending") return null;
  const { id, kind, title, summary, sourceRunId, payload } = read.interaction;
  return { id, kind, title, summary, sourceRunId, payload };
}

async function readBlockingDispositionContinuation(db: Db, input: AddressedWakeInput): Promise<AddressedInteraction | null> {
  const context = input.contextSnapshot;
  const status = context.interactionStatus;
  if ((status !== "accepted" && status !== "rejected") || context.wakeReason !== "issue_commented" ||
      context.source !== `issue.interaction.${status === "accepted" ? "accept" : "reject"}` || context.interactionKind !== "request_confirmation") return null;
  const id = z.string().guid().safeParse(context.interactionId);
  if (!id.success) return null;
  const row = await findAddressedInteraction(db, { ...input, interactionId: id.data,
    excludeTaskOwnerAndCreator: true, allowTaskOwnerFromBlockingSource: true });
  if (!row || row.status !== status || row.kind !== "request_confirmation" || row.addresseeUserId ||
      row.resolvedByAgentId !== input.agentId || row.resolvedByUserId || !row.resolvedByRunId || !row.resolvedAt ||
      context.sourceRunId !== row.sourceRunId || !["wake_assignee", ...(status === "accepted" ? ["wake_assignee_on_accept"] : [])].includes(row.continuationPolicy) ||
      !row.payload || typeof row.payload !== "object") return null;
  const governed = "toolAction" in row.payload || "secretProposal" in row.payload || "connectionAuthorization" in row.payload;
  if (!issueThreadInteractionAttentionAgentAllowed({ agentId: input.agentId, interaction: row, governedAction: governed }) ||
      !await hasAddressedOwnerDispositionRun(db, { ...input, interactionId: row.id, resolvedRunId: row.resolvedByRunId })) return null;
  return row;
}

export async function blockingDispositionContinuationAllowed(db: Db, input: AddressedWakeInput): Promise<boolean> {
  return Boolean(await readBlockingDispositionContinuation(db, input));
}

export async function addressedInteractionWakeAlreadyConsumed(db: Db, input: AddressedWakeInput): Promise<boolean> {
  const read = await readAddressedWake(db, input);
  const row = read?.state === "pending" ? read.interaction : await readBlockingDispositionContinuation(db, input);
  if (!row) return false;
  return hasConsumedAddressedInteractionWake(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
    interactionId: row.id, excludeRequestId: input.excludeRequestId,
    phase: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
  });
}
