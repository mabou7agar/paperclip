import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("progress review HTTP contract (isolated, providers disabled)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("paperclip-review-progress-http-"); db = createDb(temporary.connectionString); });
  afterAll(async () => { await temporary?.cleanup(); });

  it("accepts an actual curl payload once, persists its receipt and rejects a replay without running a provider", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), baseline = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Progress HTTP fixture", issuePrefix: `H${companyId.slice(0, 6)}` });
    // Paused process fixture is assignable but cannot dispatch a provider or command.
    const [worker] = await db.insert(agents).values({ companyId, name: "Paused test worker", role: "engineer", adapterType: "process", status: "paused" }).returning();
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 3 },
      stages: [{ type: "review", participants: [{ type: "user", userId: "active-reviewer" }] }] })!;
    const stageId = policy.stages[0]!.id;
    const [row] = await db.insert(issues).values({ id: issueId, companyId, title: "Retain original plan and context",
      description: "Original implementation plan and accepted evidence stay attached", status: "in_review", assigneeUserId: "active-reviewer",
      responsibleUserId: "owner", executionPolicy: policy as unknown as Record<string, unknown>, executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "user", userId: "active-reviewer", agentId: null },
        returnAssignee: { type: "agent", agentId: worker!.id, userId: null }, completedStageIds: [],
        lastDecisionId: baseline, lastDecisionOutcome: "changes_requested", changesRequestedCount: 2,
        reviewProgress: { stageId, stalledRounds: 2, openFindingIds: ["F1"], requiredGateIds: ["security"],
          creditedFindingIds: [], creditedGateIds: [], lastAssessment: null },
      } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "active-reviewer", companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" }; next(); });
    app.use("/api", issueRoutes(db, {} as any)); app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No loopback port");
    const payload = { status: "in_progress", comment: "Personally verified F1 using the exact candidate and receipt; security gate remains pending.",
      reviewAssessment: { baselineDecisionId: baseline, candidateRef: "exact-candidate-digest", evidenceRefs: ["sha256:fixture-receipt"],
        openFindingIds: [], requiredGateIds: ["security"], resolvedFindingIds: ["F1"], passedGateIds: [] } };
    const curl = async () => {
      const { stdout } = await promisify(execFile)("curl", ["--silent", "--show-error", "--max-time", "20", "-X", "PATCH",
        `http://127.0.0.1:${address.port}/api/issues/${issueId}`, "-H", "Content-Type: application/json", "--data-binary", JSON.stringify(payload), "-w", "\n%{http_code}"]);
      const split = stdout.lastIndexOf("\n"); return { status: Number(stdout.slice(split + 1)), body: JSON.parse(stdout.slice(0, split)) };
    };
    try {
      const first = await curl(); expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ status: "in_progress", assigneeAgentId: worker!.id,
        description: row!.description, executionState: { reviewProgress: { stalledRounds: 0, creditedFindingIds: ["F1"], requiredGateIds: ["security"] } } });
      const replay = await curl(); expect(replay.status, JSON.stringify(replay.body)).toBe(422);
      const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
      expect(decisions).toHaveLength(1); expect(decisions[0]!.body).toContain('"resolvedFindingIds":["F1"]');
      const durable = await issueService(db).getById(issueId);
      expect(durable?.executionState).toEqual(first.body.executionState);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual([]);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
