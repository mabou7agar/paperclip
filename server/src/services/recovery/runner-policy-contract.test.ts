import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { runnerRecoveryPolicySchema, verifyRunnerEnvelope, runnerEnvelopeDomain } from "./runner-policy-contract.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const policy = { policyKey: "owner-recovery-v1", sourceCommentId: "48d961fb-502d-4ef4-994e-b7d41ca09b88",
  scope: { issueTreeRootId: companyId, profiles: ["reviewed"] }, statuses: ["failed"], allowedActions: ["route_recovery_wake"] };
describe("protected runner policy contract", () => {
  it("accepts only the explicit registered scope and closed v1 action", () => {
    expect(runnerRecoveryPolicySchema.parse(policy)).toEqual(policy);
  });
  it.each(["deploy", "approve_stage", "assign_recovery_producer", "clear_session", "create_task", "admission"])("T10/T32 rejects %s", action => {
    expect(runnerRecoveryPolicySchema.safeParse({ ...policy, allowedActions: [action] }).success).toBe(false);
  });
  it("T32 never derives authority from free text", () => {
    expect(runnerRecoveryPolicySchema.safeParse({ ...policy, sourceCommentId: undefined, text: "owner approved" }).success).toBe(false);
  });
  it("does not infer an unrecorded recovery cap", () => expect(runnerRecoveryPolicySchema.parse(policy).maxRecoveries).toBeUndefined());
  it.each([0, -1, 1.5, Infinity])("rejects invalid cap %s", maxRecoveries => {
    expect(runnerRecoveryPolicySchema.safeParse({ ...policy, maxRecoveries }).success).toBe(false);
  });
  it("T28 cannot authorize cancellation", () => {
    expect(runnerRecoveryPolicySchema.safeParse({ ...policy, statuses: ["cancelled"] }).success).toBe(false);
  });
});
describe("server verification of native runner envelopes", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const value = { schema: "paperclip.runner-envelope.v1", pluginKey: "paperclip.ubuntu-runner-results", pluginId,
    companyId, kind: "result", jobId: companyId, issueId: companyId, agentId: companyId, projectId: companyId,
    requestDigest: "a".repeat(64), sequence: 1, data: { receiptSha256: "b".repeat(64) } };
  function envelope(data = value) {
    const bytes = Buffer.from(JSON.stringify(data));
    return { payload: bytes.toString("base64"), signature: sign(null, Buffer.concat([Buffer.from(runnerEnvelopeDomain), bytes]), privateKey).toString("base64") };
  }
  it("verifies the same domain and signature as the native plugin", () => {
    expect(verifyRunnerEnvelope(envelope(), { pluginId, publicKey })).toEqual(value);
  });
  it("T17 rejects tampered payloads", () => {
    const saved = envelope();
    expect(() => verifyRunnerEnvelope({ ...saved, payload: Buffer.from(JSON.stringify({ ...value, companyId: pluginId })).toString("base64") }, { pluginId, publicKey })).toThrow();
  });
  it("T26 rejects another plugin even with a valid signature", () => {
    expect(() => verifyRunnerEnvelope(envelope({ ...value, pluginId: companyId }), { pluginId, publicKey })).toThrow();
  });
  it("T31 has no unsigned verification fallback", () => {
    expect(() => verifyRunnerEnvelope(value, { pluginId, publicKey })).toThrow();
  });
});
