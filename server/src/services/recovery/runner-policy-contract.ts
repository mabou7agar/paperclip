import { verify, type KeyObject } from "node:crypto";
import { z } from "zod";

export const runnerEnvelopeDomain = "paperclip.ubuntu-runner-results.envelope.v1\n";
export const runnerRecoverySourceCommentId = "48d961fb-502d-4ef4-994e-b7d41ca09b88";
/** Closed v1 contract: no assignment, admission, stage, session or deployment authority. */
export const runnerRecoveryPolicySchema = z.object({
  policyKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/),
  sourceCommentId: z.literal(runnerRecoverySourceCommentId),
  scope: z.object({ issueTreeRootId: z.string().uuid(), profiles: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(32) }).strict(),
  statuses: z.tuple([z.literal("failed")]),
  allowedActions: z.tuple([z.literal("route_recovery_wake")]),
  maxRecoveries: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
}).strict();
export type RunnerRecoveryPolicy = z.infer<typeof runnerRecoveryPolicySchema>;
export interface RunnerTrust { pluginId: string; publicKey: KeyObject }
export const runnerEnvelopeIdentity = z.object({
  schema: z.literal("paperclip.runner-envelope.v1"), pluginKey: z.literal("paperclip.ubuntu-runner-results"),
  pluginId: z.string().uuid(), companyId: z.string().uuid(), kind: z.enum(["admission", "result"]),
  jobId: z.string().uuid(), issueId: z.string().uuid(), projectId: z.string().uuid(), agentId: z.string().uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().nonnegative(), data: z.unknown(),
}).passthrough();

/** Reverify original bytes, not the plugin's assertion or a mutable JSON projection. */
export function verifyRunnerEnvelope(input: unknown, trust: RunnerTrust) {
  const envelope = z.object({ payload: z.string().max(180000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().parse(input);
  const bytes = Buffer.from(envelope.payload, "base64");
  if (trust.publicKey.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== envelope.payload || bytes.length > 128 * 1024 ||
    !verify(null, Buffer.concat([Buffer.from(runnerEnvelopeDomain), bytes]), trust.publicKey, Buffer.from(envelope.signature, "base64"))) {
    throw new Error("runner_native_signature_invalid");
  }
  const result = runnerEnvelopeIdentity.parse(JSON.parse(bytes.toString("utf8")));
  if (result.pluginId !== trust.pluginId || (result.kind === "admission" ? result.sequence !== 0 : result.sequence <= 0)) {
    throw new Error("runner_native_envelope_scope_invalid");
  }
  return result;
}
