import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { usageHealthPolicySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { usageHealthRepository } from "../repositories/usage-health.js";
import { usageHealthService } from "../services/usage-health.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "usage health database and alert delivery",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase("usage-health-");
      db = createDb(database.connectionString);
    }, 90000);
    afterAll(async () => {
      await database?.cleanup();
    });
    it("applies recovery only to older receipts for the acknowledged account", async () => {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        subscription = randomUUID(),
        api = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Recovery",
        issuePrefix: `R${companyId.slice(0, 6)}`,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Worker",
        adapterType: "claude_local",
      });
      const old = new Date(Date.now() - 10_000);
      for (const connectionId of [subscription, api])
        await db.insert(heartbeatRuns).values({
          companyId,
          agentId,
          invocationSource: "manual",
          status: "failed",
          finishedAt: old,
          errorCode: "provider_quota",
          contextSnapshot: { aiConnection: { connectionId } },
        });
      const repo = providerQuotaRepository(db);
      const original = await repo.latestEvidence(companyId, api, new Date());
      expect(original).not.toBeNull();
      await db.insert(activityLog).values({
        companyId,
        actorType: "user",
        actorId: "owner",
        action: "ai_connection.quota_recovery_acknowledged",
        entityType: "tool_connection",
        entityId: api,
      });
      expect(await repo.latestEvidence(companyId, api, new Date())).toBeNull();
      expect(
        await repo.latestEvidence(companyId, subscription, new Date()),
      ).not.toBeNull();
      const newer = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: newer,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "failed",
        finishedAt: new Date(Date.now() + 1000),
        errorCode: "provider_quota",
        contextSnapshot: { aiConnection: { connectionId: api } },
      });
      expect(
        await repo.latestEvidence(companyId, api, new Date()),
      ).toMatchObject({ id: newer });
    });

    it("counts every source once, separates historical cache writes, scopes data and deduplicates alerts", async () => {
      const companyId = randomUUID(),
        foreign = randomUUID(),
        agentId = randomUUID(),
        issueId = randomUUID(),
        runId = randomUUID(),
        eventId = randomUUID();
      const now = new Date(),
        before = new Date(now.getTime() - 20 * 60_000),
        from = new Date(now.getTime() - 5 * 60_000);
      for (const id of [companyId, foreign])
        await db
          .insert(companies)
          .values({ id, name: "Usage", issuePrefix: `U${id.slice(0, 6)}` });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Worker",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db
        .insert(issues)
        .values({ id: issueId, companyId, title: "Task", status: "todo" });
      for (let n = 0; n < 2; n++)
        await db.insert(heartbeatRuns).values({
          companyId,
          agentId,
          issueId,
          invocationSource: "manual",
          status: "succeeded",
          startedAt: before,
          finishedAt: before,
          usageJson: { inputTokens: 1000, outputTokens: 10 },
        });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        issueId,
        invocationSource: "manual",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        sessionIdBefore: "same",
        sessionIdAfter: "same",
        usageJson: {
          provider: "anthropic",
          model: "claude-test",
          inputTokens: 100000,
          cachedInputTokens: 200000,
          outputTokens: 10000,
          billingType: "subscription_included",
        },
        resultJson: { usage: { cachedWriteTokens: 40000 } },
        contextSnapshot: {
          aiConnection: { provider: "anthropic", method: "api_key" },
          privateCanary: "must-not-be-returned",
        },
      });
      await db.insert(costEvents).values([
        {
          companyId,
          agentId,
          heartbeatRunId: runId,
          provider: "anthropic",
          model: "claude-test",
          inputTokens: 100000,
          cachedInputTokens: 200000,
          outputTokens: 10000,
          costCents: 0,
          occurredAt: now,
        },
        {
          id: eventId,
          companyId,
          usageKind: "fast_response",
          provider: "openai",
          model: "small-model",
          inputTokens: 2000,
          cachedInputTokens: 500,
          outputTokens: 10,
          costCents: 0,
          occurredAt: now,
        },
      ]);
      await db
        .insert(costEvents)
        .values({
          companyId,
          usageKind: "agent",
          agentId,
          provider: "openai",
          model: "standalone",
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 2,
          costCents: 0,
          occurredAt: now,
        });
      await db.insert(costEvents).values({
        companyId: foreign,
        usageKind: "decision",
        provider: "openai",
        model: "private",
        inputTokens: 999999,
        costCents: 0,
        occurredAt: now,
      });
      await db.insert(heartbeatRuns).values(
        Array.from({ length: 501 }, () => ({
          companyId,
          agentId,
          issueId,
          invocationSource: "manual",
          status: "cancelled",
          errorCode: "phase_quota_cooldown",
          createdAt: sql`now()`,
        })),
      );
      const repo = usageHealthRepository(db),
        service = usageHealthService(db);
      await repo.savePolicy(
        companyId,
        usageHealthPolicySchema.parse({
          enabled: true,
          thresholds: { inputTokensPerRun: 1000, runsPerTaskHour: 2 },
          agentOverrides: { [agentId]: { inputTokensPerRun: 50000 } },
        }),
      );
      const report = await service.report(
        companyId,
        from,
        new Date(Date.now() + 60_000),
        true,
      );
      expect(report.totals).toMatchObject({
        runs: 504,
        measuredRuns: 3,
        missingRuns: 0,
        inputTokens: 102100,
        cachedInputTokens: 200520,
        cacheWriteTokens: 40000,
        cacheWriteMeasuredRuns: 1,
        outputTokens: 10012,
        totalTokens: 312632,
      });
      expect(report.flagCount).toBe(4);
      expect(
        report.flags.some(
          (f) => f.rule === "repeated_runs" && f.observed === 3,
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain("must-not-be-returned");
      expect(JSON.stringify(report)).not.toContain("private");
      const publications = await Promise.all([
        service.captureObservation(companyId, runId),
        service.captureObservation(companyId, runId),
      ]);
      expect(publications.flat()).toHaveLength(3);
      expect(
        await service.captureObservation(companyId, eventId, "fast_response"),
      ).toHaveLength(1);
      const alerts = await repo.recentAlerts(
        companyId,
        from,
        new Date(Date.now() + 60_000),
      );
      expect(alerts).toHaveLength(4);
      await repo.savePolicy(
        companyId,
        usageHealthPolicySchema.parse({ enabled: false }),
      );
      expect(await service.captureObservation(companyId, runId)).toEqual([]);
    }, 60000);
  },
);
