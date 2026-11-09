import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  companyPhaseRouting,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  providerQuotaProbes,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  select: vi.fn(),
  credential: vi.fn(),
}));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => mocks,
}));
import { connectionUsageCapsService } from "../services/connection-usage-caps.js";
import { connectionUsageRepository } from "../repositories/connection-usage.js";
import { connectionCapacityRecoveryService } from "../services/connection-capacity-recovery.js";
import { phaseRoutingService } from "../services/phase-routing.js";
import { providerQuotaHealthSchedule } from "../services/provider-quota-health-schedule.js";
import { providerQuotaProbeService } from "../services/provider-quota-probes.js";
import { providerQuotaProbeRepository } from "../repositories/provider-quota-probes.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { usageHealthRepository } from "../repositories/usage-health.js";
import { phaseRoutingRoutes } from "../routes/phase-routing.js";
import { errorHandler } from "../middleware/error-handler.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "durable API quota health checks",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase("api-quota-probes-");
      db = createDb(database.connectionString);
    }, 90000);
    afterAll(async () => {
      await database?.cleanup();
    });
    afterEach(async () => {
      await db.execute(sql`truncate companies cascade`);
      vi.clearAllMocks();
    });
    async function fixture(ageMs = 3600000) {
      const now = new Date(),
        companyId = randomUUID(),
        agentId = randomUUID(),
        connectionId = randomUUID(),
        grantId = randomUUID(),
        issueId = randomUUID(),
        sourceId = randomUUID(),
        waitId = randomUUID();
      const binding = {
        mode: "shared" as const,
        provider: "anthropic" as const,
        method: "api_key" as const,
        connectionId,
        grantId,
      };
      const profile = {
        id: "api",
        adapterType: "claude_local" as const,
        model: "test-model",
        binding,
      };
      const policy = {
        enabled: true,
        planning: [profile],
        implementation: [profile],
        review: [profile],
        unknownResetCooldownSeconds: 0,
        apiQuotaRecheckSeconds: 1800,
      };
      await db
        .insert(companies)
        .values({ id: companyId, name: "Probe fixture", issuePrefix: "PRB" });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Worker",
        role: "engineer",
        adapterType: "claude_local",
      });
      const applicationId = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId,
        name: "Test API app",
        type: "rest_api",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        uid: "fixture-api",
        name: "Test API",
        connectionPurpose: "ai",
        transport: "runtime_auth",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {
          ai: {
            provider: "anthropic",
            method: "api_key",
            routing: {
              kind: "gateway",
              protocol: "messages",
              baseUrl: "https://gateway.example",
              auth: "bearer",
              models: [],
            },
          },
        },
      } as never);
      await db.insert(connectionGrants).values({
        id: grantId,
        companyId,
        connectionId,
        kind: "organization",
        status: "active",
        credentialSecretRefs: [],
      } as never);
      await db.insert(companyPhaseRouting).values({ companyId, policy });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Saved review",
        identifier: "PRB-1",
        status: "in_review",
        assigneeAgentId: agentId,
        workMode: "standard",
      });
      await db.insert(heartbeatRuns).values({
        id: sourceId,
        companyId,
        agentId,
        issueId,
        status: "failed",
        invocationSource: "assignment",
        errorCode: "provider_quota",
        responsibleUserId: "owner",
        finishedAt: new Date(now.getTime() - ageMs),
        contextSnapshot: {
          issueId,
          aiConnection: {
            connectionId,
            grantId,
            provider: "anthropic",
            method: "api_key",
          },
        },
        usageJson: { model: "test-model" },
      });
      await db.insert(heartbeatRuns).values({
        id: waitId,
        companyId,
        agentId,
        issueId,
        status: "scheduled_retry",
        invocationSource: "assignment",
        responsibleUserId: "owner",
        createdAt: new Date(now.getTime() - 1000),
        scheduledRetryReason: "ai_connection_pool_wait",
        scheduledRetryAttempt: 1,
        scheduledRetryAt: new Date(now.getTime() + 3600000),
        retryOfRunId: sourceId,
        contextSnapshot: { issueId, marker: "original-context" },
      });
      mocks.list.mockResolvedValue([
        { id: connectionId, grantId, ownership: "shared", status: "connected" },
      ]);
      const [selectedConnection] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, connectionId));
      const [selectedGrant] = await db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.id, grantId));
      mocks.select.mockResolvedValue({
        connection: selectedConnection,
        grant: selectedGrant,
        attribution: { provider: "anthropic", method: "api_key" },
      });
      mocks.credential.mockResolvedValue("fixture-secret");
      return {
        now,
        companyId,
        agentId,
        connectionId,
        grantId,
        issueId,
        sourceId,
        waitId,
        policy,
      };
    }
    it("reconstructs configured health deadlines without resolving credentials and disarms recovered accounts", async () => {
      const f = await fixture(60_000);
      const schedule = providerQuotaHealthSchedule(db, () => f.now);
      expect(await schedule.next()).toBe(f.now.getTime() + 1_740_000);
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
      const due = new Date(f.now.getTime() + 1_740_000);
      const repository = providerQuotaProbeRepository(db);
      const claim = await repository.claim({ companyId: f.companyId, connectionId: f.connectionId,
        grantId: f.grantId, sourceRunId: f.sourceId, model: "test-model", intervalSeconds: 1800, now: due });
      expect(claim).not.toBeNull();
      await repository.complete(claim!.id, { outcome: "available", usage: {
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0,
      }, retryAfterSeconds: null }, due);
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      expect(await schedule.next()).toBeNull();
      await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
      // Recovery remains due until its durable delivery receipt is stored.
      expect(await schedule.next()).toBe(f.now.getTime());
      const recovery = await repository.claimRecovery(claim!.id, due);
      await repository.delivered(claim!.id, recovery!.recoveryClaimId!, due);
      expect(await schedule.next()).toBeNull();
    });
    it("preserves claim retry deadlines and stops scheduling disabled policies", async () => {
      const f = await fixture();
      const repository = providerQuotaProbeRepository(db);
      const claim = await repository.claim({ companyId: f.companyId, connectionId: f.connectionId,
        grantId: f.grantId, sourceRunId: f.sourceId, model: "test-model", intervalSeconds: 1800, now: f.now });
      await repository.complete(claim!.id, { outcome: "quota", usage: {
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
      }, retryAfterSeconds: 7200 }, f.now);
      expect(await providerQuotaHealthSchedule(db, () => f.now).next()).toBe(f.now.getTime() + 7_200_000);
      await db.update(companyPhaseRouting).set({ policy: { ...f.policy, apiQuotaRecheckSeconds: 0 } })
        .where(eq(companyPhaseRouting.companyId, f.companyId));
      expect(await providerQuotaHealthSchedule(db, () => f.now).next()).toBeNull();
    });
    it("does not probe or promote a capacity wait while draining", async () => {
      const f = await fixture(), retry = vi.fn(), request = vi.fn();
      expect(await providerQuotaProbeService(db, retry, request, () => f.now).sweep(f.now, () => false))
        .toEqual({ checked: 0, recovered: 0 });
      expect(await connectionCapacityRecoveryService(db, retry).reconcile(f.companyId, f.now, () => false))
        .toEqual({ promoted: 0 });
      expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.credential).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });
    const success = () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 14, output_tokens: 5 },
        }),
      );
    it("shares account usage across agents and grants without double counting mirrored receipts or cache writes", async () => {
      const f = await fixture();
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          errorCode: null,
          usageJson: {
            inputTokens: 999,
            cacheWriteTokens: 900,
            cachedInputTokens: 100,
            outputTokens: 999,
            billingType: "metered_api",
          },
        })
        .where(eq(heartbeatRuns.id, f.sourceId));
      await db.insert(costEvents).values({
        companyId: f.companyId,
        agentId: f.agentId,
        heartbeatRunId: f.sourceId,
        connectionId: f.connectionId,
        provider: "anthropic",
        model: "test-model",
        billingType: "metered_api",
        costStatus: "reported",
        inputTokens: 100,
        cachedInputTokens: 200,
        outputTokens: 10,
        costCents: 25,
        occurredAt: new Date(f.now.getTime() - 1000),
      });
      await db.insert(providerQuotaProbes).values({
        companyId: f.companyId,
        connectionId: f.connectionId,
        grantId: randomUUID(),
        model: "test-model",
        startedAt: new Date(f.now.getTime() - 500),
        nextCheckAt: f.now,
        outcome: "available",
        usage: {
          inputTokens: 14,
          outputTokens: 5,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const secondAgent = randomUUID();
      await db.insert(agents).values({
        id: secondAgent,
        companyId: f.companyId,
        name: "Second worker",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db.insert(costEvents).values({
        companyId: f.companyId,
        agentId: secondAgent,
        connectionId: f.connectionId,
        provider: "anthropic",
        model: "test-model",
        billingType: "metered_api",
        costStatus: "reported",
        inputTokens: 20,
        outputTokens: 5,
        costCents: 10,
        occurredAt: new Date(f.now.getTime() - 1000),
      });
      const observations = await connectionUsageRepository(db).observations(
        f.companyId,
        f.connectionId,
        new Date(f.now.getTime() - 86400000),
        f.now,
      );
      expect(observations.reduce((n, r) => n + (r.tokens ?? 0), 0)).toBe(354);
      expect(
        await connectionUsageRepository(db).owns(randomUUID(), [
          f.connectionId,
        ]),
      ).toBe(false);
      const status = await connectionUsageCapsService(db).check(
        f.companyId,
        f.connectionId,
        f.now,
        { daily: { tokens: 300 } },
      );
      expect(status.blocked).toBe(true);
      expect(status.windows[0].tokens).toBe(354);
      expect(
        (
          await connectionUsageCapsService(db).check(
            f.companyId,
            f.connectionId,
            f.now,
            { daily: { apiCostUsd: "1" } },
          )
        ).windows[0].apiCostUsd,
      ).toBeNull();
      await db
        .update(costEvents)
        .set({ heartbeatRunId: null })
        .where(eq(costEvents.companyId, f.companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
      expect(
        (
          await connectionUsageRepository(db).observations(
            f.companyId,
            f.connectionId,
            new Date(f.now.getTime() - 86400000),
            f.now,
          )
        ).reduce((n, r) => n + (r.tokens ?? 0), 0),
      ).toBe(354);
    });
    it("skips a capped primary even with an agent override and keeps the selected fallback session identity stable", async () => {
      const f = await fixture();
      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          errorCode: null,
          usageJson: {
            inputTokens: 100,
            outputTokens: 1,
            cachedInputTokens: 0,
            billingType: "subscription_included",
          },
        })
        .where(eq(heartbeatRuns.id, f.sourceId));
      const backupId = randomUUID(),
        selected = await mocks.select();
      mocks.select.mockImplementation(async ({ binding }) =>
        binding.connectionId === backupId
          ? {
              ...selected,
              connection: { ...selected.connection, id: backupId },
            }
          : selected,
      );
      const primary = f.policy.planning[0],
        backup = {
          ...primary,
          id: "backup",
          binding: { ...primary.binding, connectionId: backupId },
        };
      const policy = {
        ...f.policy,
        planning: [primary, backup],
        connectionUsageCaps: {
          [f.connectionId]: { rolling5h: { tokens: 100 } },
        },
      };
      await db
        .update(companyPhaseRouting)
        .set({ policy })
        .where(eq(companyPhaseRouting.companyId, f.companyId));
      const input = {
        companyId: f.companyId,
        agentId: f.agentId,
        userId: "owner",
        adapterType: "claude_local",
        runtimeConfig: {
          phaseRouting: {
            ...f.policy,
            planning: [primary, backup],
            connectionUsageCaps: {},
          },
        },
        workMode: "planning",
        isConversation: false,
        issueId: f.issueId,
        now: f.now,
      };
      const first = await phaseRoutingService(db).resolve(input),
        second = await phaseRoutingService(db).resolve(input);
      expect(first?.profile?.id).toBe("backup");
      expect(first?.connectionId).toBe(backupId);
      expect(second).toEqual(first);
      expect(mocks.credential).not.toHaveBeenCalled();
    });
    it("releases the same capacity continuation at renewal once and retains its retry count and context", async () => {
      const f = await fixture();
      await db
        .update(heartbeatRuns)
        .set({
          errorCode: "phase_quota_cooldown",
          resultJson: {
            connectionUsageCapWait: true,
            executionRecovery: { providerWorkStarted: false },
          },
        })
        .where(eq(heartbeatRuns.id, f.sourceId));
      await db.insert(costEvents).values({
        companyId: f.companyId,
        agentId: f.agentId,
        connectionId: f.connectionId,
        provider: "anthropic",
        model: "test-model",
        billingType: "subscription_included",
        costStatus: "reported",
        inputTokens: 100,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date(f.now.getTime() - 5 * 3600000 + 1000),
      });
      await db
        .update(companyPhaseRouting)
        .set({
          policy: {
            ...f.policy,
            connectionUsageCaps: {
              [f.connectionId]: { rolling5h: { tokens: 100 } },
            },
          },
        })
        .where(eq(companyPhaseRouting.companyId, f.companyId));
      const retry = vi.fn(
        async ({ expectedRunId }: { expectedRunId?: string }) => {
          if (!expectedRunId) throw Error("Expected exact saved continuation");
          const promoted = await db
            .update(heartbeatRuns)
            .set({ status: "queued" })
            .where(
              and(
                eq(heartbeatRuns.id, expectedRunId),
                eq(heartbeatRuns.status, "scheduled_retry"),
              ),
            )
            .returning({ id: heartbeatRuns.id });
          return {
            outcome: promoted.length ? "promoted" : "already_promoted",
          } as never;
        },
      );
      const recovery = connectionCapacityRecoveryService(db, retry);
      expect(await recovery.reconcile(f.companyId, f.now)).toEqual({
        promoted: 0,
      });
      expect(retry).not.toHaveBeenCalled();
      const due = new Date(f.now.getTime() + 1000);
      const results = await Promise.all([
        recovery.reconcile(f.companyId, due),
        recovery.reconcile(f.companyId, due),
      ]);
      expect(results.reduce((n, r) => n + r.promoted, 0)).toBe(1);
      expect(await recovery.reconcile(f.companyId, due)).toEqual({
        promoted: 0,
      });
      const [wait] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.waitId));
      expect(wait).toMatchObject({
        id: f.waitId,
        status: "queued",
        scheduledRetryAttempt: 1,
        contextSnapshot: { marker: "original-context" },
      });
    });
    it("checks an official Anthropic connection without requiring custom gateway metadata", async () => {
      const f = await fixture();
      const ai = { provider: "anthropic", method: "api_key" };
      const [connection] = await db
        .update(toolConnections)
        .set({ config: { ai } as never })
        .where(eq(toolConnections.id, f.connectionId))
        .returning();
      const selected = await mocks.select();
      mocks.select.mockResolvedValue({ ...selected, connection });
      const request = vi.fn(async () => success()),
        retry = vi.fn(async () => ({ outcome: "promoted" }) as never);
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).toHaveBeenCalledTimes(1);
      const [url, options] = request.mock.calls[0] as unknown as [
        URL,
        RequestInit,
      ];
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      expect(options.headers).toMatchObject({ "x-api-key": "fixture-secret" });
      expect(retry).toHaveBeenCalledTimes(1);
    });
    it("renews recovery ownership during a long batch and fences the replaced owner", async () => {
      const f = await fixture(),
        repository = providerQuotaProbeRepository(db);
      const probe = await repository.claim({
        companyId: f.companyId,
        connectionId: f.connectionId,
        grantId: f.grantId,
        sourceRunId: f.sourceId,
        model: "test-model",
        intervalSeconds: 1800,
        now: f.now,
      });
      await repository.complete(
        probe!.id,
        { outcome: "available", usage: null, retryAfterSeconds: null },
        f.now,
      );
      const first = await repository.claimRecovery(probe!.id, f.now);
      expect(
        await repository.renewRecovery(
          probe!.id,
          first!.recoveryClaimId!,
          new Date(f.now.getTime() + 100000),
        ),
      ).toBe(true);
      expect(
        await repository.claimRecovery(
          probe!.id,
          new Date(f.now.getTime() + 130000),
        ),
      ).toBeNull();
      const replacement = await repository.claimRecovery(
        probe!.id,
        new Date(f.now.getTime() + 221000),
      );
      expect(replacement!.recoveryClaimId).not.toBe(first!.recoveryClaimId);
      expect(
        await repository.renewRecovery(
          probe!.id,
          first!.recoveryClaimId!,
          new Date(f.now.getTime() + 222000),
        ),
      ).toBe(false);
      expect(
        await repository.renewRecovery(
          probe!.id,
          replacement!.recoveryClaimId!,
          new Date(f.now.getTime() + 222000),
        ),
      ).toBe(true);
      await repository.delivered(
        probe!.id,
        replacement!.recoveryClaimId!,
        new Date(f.now.getTime() + 222000),
      );
      expect(
        await repository.renewRecovery(
          probe!.id,
          replacement!.recoveryClaimId!,
          new Date(f.now.getTime() + 223000),
        ),
      ).toBe(false);
    });
    it("coalesces concurrent sweeps, restores the exact account and releases its saved continuation once", async () => {
      const f = await fixture(),
        request = vi.fn(async () => success()),
        retry = vi.fn(async () => ({ outcome: "promoted" }) as never);
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId,
        agentId: f.agentId,
        status: "failed",
        invocationSource: "assignment",
        errorCode: "provider_quota",
        finishedAt: new Date(f.now.getTime() - 7200000),
        contextSnapshot: {
          aiConnection: { connectionId: f.connectionId, grantId: f.grantId },
        },
      });
      await Promise.all([
        providerQuotaProbeService(
          db,
          retry,
          request as typeof fetch,
          () => f.now,
        ).sweep(),
        providerQuotaProbeService(
          db,
          retry,
          request as typeof fetch,
          () => f.now,
        ).sweep(),
      ]);
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: f.issueId,
          expectedRunId: f.waitId,
        }),
      );
      expect(
        await providerQuotaRepository(db).latestEvidence(
          f.companyId,
          f.connectionId,
          f.now,
          f.grantId,
        ),
      ).toBeNull();
      const [wait] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, f.waitId));
      expect(wait).toMatchObject({
        scheduledRetryAttempt: 1,
        contextSnapshot: { marker: "original-context" },
      });
      const health = await usageHealthRepository(db).observations(
        f.companyId,
        new Date(f.now.getTime() - 86400000),
        new Date(f.now.getTime() + 1000),
      );
      expect(health.find((r) => r.kind === "quota_probe")).toMatchObject({
        inputTokens: 14,
        outputTokens: 5,
        cacheWriteTokens: 0,
      });
    });
    it("checks at due intervals with backoff and no agent wakes while quota remains exhausted", async () => {
      const f = await fixture(),
        request = vi.fn(
          async () => new Response('{"error":{}}', { status: 429 }),
        ),
        retry = vi.fn();
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => new Date(f.now.getTime() + 1799000),
      ).sweep();
      expect(request).toHaveBeenCalledTimes(1);
      const later = new Date(f.now.getTime() + 1801000);
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => later,
      ).sweep();
      expect(request).toHaveBeenCalledTimes(2);
      expect(retry).not.toHaveBeenCalled();
      const rows = await db
        .select()
        .from(providerQuotaProbes)
        .orderBy(providerQuotaProbes.startedAt);
      expect(rows[1].nextCheckAt.getTime() - later.getTime()).toBe(3600000);
      expect(rows[1].usage).toBeNull();
      const health = await usageHealthRepository(db).observations(
        f.companyId,
        new Date(f.now.getTime() - 86400000),
        new Date(later.getTime() + 1000),
      );
      expect(
        health
          .filter((row) => row.kind === "quota_probe")
          .every((row) => row.expectedNoUsage && row.inputTokens === null),
      ).toBe(true);
    });
    it("waits one interval after the original failure and retains an uncertain dispatch across a restart", async () => {
      const f = await fixture(1000),
        request = vi.fn(async () => success()),
        retry = vi.fn();
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).not.toHaveBeenCalled();
      const later = new Date(f.now.getTime() + 1800000),
        repo = providerQuotaProbeRepository(db);
      expect(
        await repo.claim({
          ...f,
          sourceRunId: f.sourceId,
          model: "test-model",
          intervalSeconds: 1800,
          now: later,
        }),
      ).not.toBeNull();
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => later,
      ).sweep();
      expect(request).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    });
    it("never clears a newer failure or a different grant using an older successful probe", async () => {
      const f = await fixture(),
        repo = providerQuotaProbeRepository(db);
      const claim = await repo.claim({
        ...f,
        sourceRunId: f.sourceId,
        model: "test-model",
        intervalSeconds: 1800,
        now: f.now,
      });
      expect(claim).not.toBeNull();
      await repo.complete(
        claim!.id,
        {
          outcome: "available",
          usage: {
            inputTokens: 14,
            outputTokens: 5,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
          },
          retryAfterSeconds: null,
        },
        new Date(f.now.getTime() + 1000),
      );
      const newerId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: newerId,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "failed",
        invocationSource: "assignment",
        errorCode: "provider_quota",
        finishedAt: new Date(f.now.getTime() + 500),
        contextSnapshot: {
          aiConnection: { connectionId: f.connectionId, grantId: f.grantId },
        },
      });
      expect(
        (
          await providerQuotaRepository(db).latestEvidence(
            f.companyId,
            f.connectionId,
            new Date(),
            f.grantId,
          )
        )?.id,
      ).toBe(newerId);
      const otherGrant = randomUUID(),
        otherFailure = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: otherFailure,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "failed",
        invocationSource: "assignment",
        errorCode: "provider_quota",
        finishedAt: new Date(f.now.getTime() - 60000),
        contextSnapshot: {
          aiConnection: { connectionId: f.connectionId, grantId: otherGrant },
        },
      });
      expect(
        (
          await providerQuotaRepository(db).latestEvidence(
            f.companyId,
            f.connectionId,
            new Date(),
            otherGrant,
          )
        )?.id,
      ).toBe(otherFailure);
    });
    it("invalidates a successful response when its credential rotates during the request", async () => {
      const f = await fixture(),
        retry = vi.fn(),
        request = vi.fn(async () => {
          mocks.credential.mockResolvedValue("rotated-secret");
          return success();
        });
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(retry).not.toHaveBeenCalled();
      expect((await db.select().from(providerQuotaProbes))[0]).toMatchObject({
        outcome: "unavailable",
        usage: { inputTokens: 14, outputTokens: 5 },
      });
      expect(
        await providerQuotaRepository(db).latestEvidence(
          f.companyId,
          f.connectionId,
          f.now,
          f.grantId,
        ),
      ).not.toBeNull();
    });
    it("honors disabled checks and connection overrides without decrypting credentials", async () => {
      const f = await fixture(),
        request = vi.fn(async () => success()),
        retry = vi.fn();
      await db
        .update(companyPhaseRouting)
        .set({
          policy: {
            ...f.policy,
            apiQuotaRecheckOverrides: { [f.connectionId]: 0 },
          },
        })
        .where(eq(companyPhaseRouting.companyId, f.companyId));
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).not.toHaveBeenCalled();
      expect(mocks.credential).not.toHaveBeenCalled();
      await db
        .update(companyPhaseRouting)
        .set({
          policy: {
            ...f.policy,
            enabled: false,
            apiQuotaRecheckOverrides: { [f.connectionId]: 1800 },
          },
        })
        .where(eq(companyPhaseRouting.companyId, f.companyId));
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });
    it("records configuration rejection as no provider work and never dispatches", async () => {
      const f = await fixture(),
        request = vi.fn(async () => success()),
        retry = vi.fn();
      mocks.credential.mockRejectedValue(new Error("credential unavailable"));
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect((await db.select().from(providerQuotaProbes))[0]).toMatchObject({
        outcome: "configuration",
        trigger: "scheduled",
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    });
    it("uses the destination from the current authorized selection, not stale candidate metadata", async () => {
      const f = await fixture(),
        retry = vi.fn();
      const selection = await mocks.select();
      selection.connection.config.ai.routing.baseUrl =
        "https://current.example";
      const request = vi.fn(async () => success());
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(request).toHaveBeenCalledTimes(1);
      expect(String((request.mock.calls[0] as unknown as [URL])[0])).toBe(
        "https://current.example/v1/messages",
      );
    });
    it("invalidates replacement of the same credential bytes using its grant revision", async () => {
      const f = await fixture(),
        retry = vi.fn(),
        selection = await mocks.select();
      const request = vi.fn(async () => {
        mocks.select.mockResolvedValue({
          ...selection,
          grant: {
            ...selection.grant,
            updatedAt: new Date(selection.grant.updatedAt.getTime() + 1),
          },
        });
        return success();
      });
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      expect(retry).not.toHaveBeenCalled();
      expect((await db.select().from(providerQuotaProbes))[0].outcome).toBe(
        "unavailable",
      );
    });
    it("starts a fresh base interval after recovery without replaying the already checked failure", async () => {
      const f = await fixture(),
        repo = providerQuotaProbeRepository(db);
      const first = await repo.claim({
        ...f,
        sourceRunId: f.sourceId,
        model: "test-model",
        intervalSeconds: 1800,
        now: f.now,
      });
      await db
        .update(providerQuotaProbes)
        .set({ nextCheckAt: new Date(f.now.getTime() + 86400000) })
        .where(eq(providerQuotaProbes.id, first!.id));
      await repo.complete(
        first!.id,
        {
          outcome: "available",
          usage: {
            inputTokens: 14,
            outputTokens: 5,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
          },
          retryAfterSeconds: null,
        },
        f.now,
      );
      expect(
        await repo.claim({
          ...f,
          sourceRunId: f.sourceId,
          model: "test-model",
          intervalSeconds: 1800,
          now: new Date(f.now.getTime() + 86400001),
        }),
      ).toBeNull();
      const nextSource = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextSource,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "failed",
        invocationSource: "assignment",
        errorCode: "provider_quota",
        responsibleUserId: "owner",
        finishedAt: new Date(f.now.getTime() + 1),
        contextSnapshot: {
          aiConnection: { connectionId: f.connectionId, grantId: f.grantId },
        },
        usageJson: { model: "test-model" },
      });
      const next = await repo.claim({
        ...f,
        sourceRunId: nextSource,
        model: "test-model",
        intervalSeconds: 1800,
        now: new Date(f.now.getTime() + 1800001),
      });
      expect(next).toMatchObject({ failureCount: 0 });
      expect(next!.nextCheckAt.getTime()).toBe(f.now.getTime() + 3600001);
    });
    it("keeps probe accounting after the original failed run is deleted", async () => {
      const f = await fixture(),
        request = vi.fn(async () => success()),
        retry = vi.fn();
      await providerQuotaProbeService(
        db,
        retry,
        request as typeof fetch,
        () => f.now,
      ).sweep();
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceId));
      const [receipt] = await db.select().from(providerQuotaProbes);
      expect(receipt).toMatchObject({
        sourceRunId: null,
        usage: { inputTokens: 14, outputTokens: 5 },
      });
    });
    it("round-trips the configurable policy through the real versioned route using curl", async () => {
      const f = await fixture(),
        app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          source: "local_implicit",
          userId: "owner",
          companyIds: [f.companyId],
          memberships: [
            {
              companyId: f.companyId,
              status: "active",
              membershipRole: "owner",
            },
          ],
        } as never;
        next();
      });
      app.use("/api", phaseRoutingRoutes(db));
      app.use(errorHandler);
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      try {
        const address = server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/api/v1/companies/${f.companyId}/phase-routing`;
        const curl = promisify(execFile),
          payload = {
            ...f.policy,
            apiQuotaRecheckSeconds: 900,
            apiQuotaRecheckOverrides: { [f.connectionId]: 1800 },
            connectionUsageCaps: {
              [f.connectionId]: {
                rolling5h: { tokens: 1000000 },
                daily: { apiCostUsd: "2.50" },
                weekly: { tokens: 5000000 },
              },
            },
          };
        const saved = await curl("curl", [
          "--silent",
          "--show-error",
          "--fail-with-body",
          "-X",
          "PUT",
          "-H",
          "Content-Type: application/json",
          "--data",
          JSON.stringify(payload),
          url,
        ]);
        expect(JSON.parse(saved.stdout).policy).toMatchObject(payload);
        const read = await curl("curl", [
          "--silent",
          "--show-error",
          "--fail-with-body",
          url,
        ]);
        expect(JSON.parse(read.stdout).policy.apiQuotaRecheckSeconds).toBe(900);
        const counters = await curl("curl", [
          "--silent",
          "--show-error",
          "--fail-with-body",
          url + "/usage",
        ]);
        expect(JSON.parse(counters.stdout).connections[0]).toMatchObject({
          connectionId: f.connectionId,
          blocked: false,
        });
        const bad = await curl("curl", [
          "--silent",
          "--show-error",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-X",
          "PUT",
          "-H",
          "Content-Type: application/json",
          "--data",
          JSON.stringify({ ...payload, apiQuotaRecheckSeconds: 1 }),
          url,
        ]);
        expect(bad.stdout).toBe("400");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
    });
  },
);
