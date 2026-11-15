import { createHash } from "node:crypto";
import type { agentWakeupRequests, Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { findPluginWakeupReceipts } from "../repositories/plugin-wakeup-receipts.js";

/** Server-derived SDK delivery identity, never accepted from a wake payload. */
export interface PluginWakeupReceipt {
  id: string;
  requestedAt: Date;
  companyId: string;
  pluginId: string;
  issueId: string;
  agentId: string;
  idempotencyKey: string;
  reason: string;
  contextSource: string;
  digest: string;
}

type PluginWakeupInput = Omit<PluginWakeupReceipt, "id" | "requestedAt" | "digest">;

export function pluginWakeupReceipt(input: PluginWakeupInput): PluginWakeupReceipt {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 240) {
    throw unprocessable("Plugin wakeup idempotencyKey must contain 1–240 characters");
  }
  // A key names one plugin/company intent. Reusing it for another task or
  // assignee is a conflict, not authority for a second delivery.
  const hash = createHash("sha256").update(JSON.stringify([
    "paperclip.plugin-wakeup.v1", input.companyId, input.pluginId, input.idempotencyKey,
  ])).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const digest = createHash("sha256").update(JSON.stringify([
    input.companyId, input.pluginId, input.issueId, input.agentId,
    input.idempotencyKey, input.reason, input.contextSource,
  ])).digest("hex");
  return { ...input, id, digest, requestedAt: new Date() };
}

/** Prior releases stored random receipt IDs. Reuse an exact unambiguous
 * legacy delivery; never reset it or reinterpret a conflicting key. */
export async function preparePluginWakeupReceipt(db: Db, input: PluginWakeupInput) {
  const intent = pluginWakeupReceipt(input);
  const rows = await findPluginWakeupReceipts(db, input.companyId, input.pluginId, input.idempotencyKey);
  if (rows.length > 1) throw conflict("Plugin wakeup has ambiguous prior delivery", {
    code: "plugin_wakeup_legacy_identity_ambiguous",
  });
  const prior = rows[0];
  if (prior) {
    intent.id = prior.id;
    intent.requestedAt = prior.requestedAt;
    assertPluginWakeupReceipt(intent, prior);
  }
  return { intent, prior };
}

export function assertPluginWakeupReceipt(
  expected: PluginWakeupReceipt,
  actual: typeof agentWakeupRequests.$inferSelect,
) {
  if (actual.id !== expected.id || actual.companyId !== expected.companyId ||
      actual.agentId !== expected.agentId || actual.source !== "assignment" ||
      actual.requestedByActorType !== "system" || actual.requestedByActorId !== expected.pluginId ||
      actual.idempotencyKey !== expected.idempotencyKey ||
      actual.payload?.issueId !== expected.issueId || actual.payload?.pluginId !== expected.pluginId ||
      (actual.payload?.pluginWakeupDigest
        ? actual.payload.pluginWakeupDigest !== expected.digest
        : actual.reason !== expected.reason || actual.payload?.contextSource !== expected.contextSource)) {
    throw conflict("Plugin wakeup key was already used for a different delivery", {
      code: "plugin_wakeup_identity_conflict",
    });
  }
}

/** Only recover a collision of this receipt's primary key; never hide other errors. */
export function isPluginWakeupReceiptCollision(error: unknown): boolean {
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 4; depth++) {
    const row = value as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (row.code === "23505" &&
        (row.constraint === "agent_wakeup_requests_pkey" || row.constraint_name === "agent_wakeup_requests_pkey")) return true;
    value = row.cause;
  }
  return false;
}
