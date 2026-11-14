import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { prepareHeartbeatSession, type HeartbeatSessionPreparationInput } from "./session-preparation.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("subscription attribution persisted session scope", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("subscription-session-scope-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function setup(variant: "same" | "issue" | "agent" | "company" | "epoch" | "stored" | "missing-run" | "missing-issue" = "same") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Billing session", issuePrefix: `B${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Saved reader", status: "idle",
      adapterType: "codex_local", adapterConfig: { model: "gpt-6.1-sol" }, runtimeConfig: {} }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Same task", issueNumber: 1, status: "todo", assigneeAgentId: agentId });
    let previousCompany = companyId, previousAgent = agentId, previousIssue = issueId;
    if (variant === "company") {
      previousCompany = randomUUID();
      await db.insert(companies).values({ id: previousCompany, name: "Other company", issuePrefix: `X${previousCompany.slice(0, 6)}` });
    }
    if (variant === "agent" || variant === "company") {
      previousAgent = randomUUID();
      await db.insert(agents).values({ id: previousAgent, companyId: previousCompany, name: "Other reader" });
    }
    if (variant === "issue" || variant === "company") {
      previousIssue = randomUUID();
      await db.insert(issues).values({ id: previousIssue, companyId: previousCompany, title: "Other task", issueNumber: 2 });
    }
    const sessionIdentity = `${randomUUID()}:owner:${randomUUID()}:0`;
    const providerSession = randomUUID(), lastRunId = randomUUID();
    const binding = { mode: "shared", provider: "openai", method: "subscription", connectionId: randomUUID(), grantId: randomUUID() };
    const managed = { ...binding, identity: "credential-generation", sessionIdentity, subscriptionId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: lastRunId, companyId: previousCompany, agentId: previousAgent,
      issueId: previousIssue, status: "succeeded", contextSnapshot: { aiConnection: { ...managed,
        sessionIdentity: variant === "epoch" ? sessionIdentity + "-replaced" : sessionIdentity } } });
    const input = {
      run: { createdAt: new Date() }, agent,
      task: { context: {}, issueRef: { id: issueId }, issueContext: null, taskProjectContext: null,
        workspaceProjectContext: null, wakeCommentId: null, acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
      session: { taskSession: null, taskSessionDecodedParams: null, explicitResumeSessionParams: null,
        explicitResumeSessionDisplayId: null, sessionCodec: { deserialize: (value: unknown) => value } },
      config: { runtimeConfig: { model: "gpt-6.1-sol", managedAiConnection: managed }, agentIdentity: undefined,
        issueAssigneeOverrides: null, originalAiIssueOverrides: null, aiBinding: binding, requestedAiBinding: binding,
        managedAiRuntime: { home: "/tmp/fixture-managed-home", identity: managed.identity, sessionIdentity },
        secretManifest: [], runtimeSkillEntries: [], routineEnvContext: { env: null } },
      workspace: { requestedExecutionWorkspaceMode: "shared_workspace", effectiveExecutionWorkspaceMode: "shared_workspace",
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, executionPolicy: null,
        requestedReusableExecutionWorkspaceConfig: null, reusableExistingExecutionWorkspace: null },
      environment: { environmentResolution: { source: "none" }, selectedEnvironmentId: null, selectedEnvironmentForConfig: null },
      getLatestAgentConfigRevision: async () => null,
    } as unknown as HeartbeatSessionPreparationInput;
    const before = await prepareHeartbeatSession(db, input);
    const metadata = before.sessionConfigMetadata;
    const params = { sessionId: providerSession, paperclipAiCredentialIdentity: variant === "stored" ? "different-authority" : sessionIdentity,
      __paperclipConfiguredModel: "gpt-6.1-sol", __paperclipConfigFingerprint: metadata.fingerprint,
      __paperclipConfigFingerprintVersion: metadata.version, __paperclipConfigCategoryFingerprints: metadata.categoryFingerprints };
    input.session.taskSession = { id: randomUUID(), companyId, agentId, adapterType: "codex_local", taskKey: issueId,
      sessionParamsJson: params, sessionDisplayId: providerSession, lastRunId: variant === "missing-run" ? null : lastRunId,
    } as NonNullable<HeartbeatSessionPreparationInput["session"]["taskSession"]>;
    input.config.runtimeConfig = { ...input.config.runtimeConfig, managedAiConnection: { ...managed, subscriptionId: randomUUID() } };
    if (variant === "missing-issue") input.task.issueRef = null;
    return { input, providerSession };
  }

  it("resumes the actual saved provider session from a same-scope persisted run", async () => {
    const { input, providerSession } = await setup();
    const result = await prepareHeartbeatSession(db, input);
    expect(result.resetTaskSession).toBe(false);
    expect(result.taskSessionForRun?.sessionDisplayId).toBe(providerSession);
    expect(result.previousSessionParams).toMatchObject({ sessionId: providerSession });
  });
  it.each(["issue", "agent", "company", "epoch", "stored", "missing-run", "missing-issue"] as const)(
    "keeps the reset for incompatible or missing persisted scope: %s", async variant => {
      const { input } = await setup(variant);
      const result = await prepareHeartbeatSession(db, input);
      expect(result.resetTaskSession).toBe(true);
      expect(result.taskSessionForRun).toBeNull();
    });
});
