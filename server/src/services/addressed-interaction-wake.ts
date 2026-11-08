import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { findAddressedInteraction } from "../repositories/addressed-interactions.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

export function isAddressedInteractionWakeContext(context: Record<string, unknown>): boolean {
  return context.wakeReason === "interaction_pending" && context.source === "issue.interaction.created";
}

/** An attention request is authority to answer its card, not task ownership.
 * Read current persisted scope and audience; never trust a wake flag alone.
 * Dispatch callers hold the issue lock, as interaction mutations do.
 */
export async function addressedInteractionWakeState(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  contextSnapshot: Record<string, unknown>;
}): Promise<"pending" | "stale" | null> {
  const context = input.contextSnapshot;
  if (!isAddressedInteractionWakeContext(context)) return null;
  const id = z.string().guid().safeParse(context.interactionId);
  if (!id.success) return "stale";
  const row = await findAddressedInteraction(db, { ...input, interactionId: id.data });
  if (!row || row.status !== "pending" || row.addresseeUserId ||
      !["ask_user_questions", "request_confirmation"].includes(row.kind) ||
      context.interactionKind !== row.kind || !row.payload || typeof row.payload !== "object") return "stale";
  const governed = row.kind === "request_confirmation" &&
    ("toolAction" in row.payload || "secretProposal" in row.payload || "connectionAuthorization" in row.payload);
  return issueThreadInteractionAttentionAgentAllowed({
    agentId: input.agentId, interaction: row, governedAction: governed,
  }) ? "pending" : "stale";
}
