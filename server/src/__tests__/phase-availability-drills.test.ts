import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, agentTaskSessions, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { phaseRoutingSchema, type PhaseAvailabilityDrill } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { phaseAvailabilityDrillRepository } from "../repositories/phase-availability-drills.js";
import { phaseAvailabilityDrillService } from "../services/phase-availability-drills.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";

describe("board-owned task availability drills", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let companyId: string, issueId: string, agentId: string, drill: PhaseAvailabilityDrill;
  const claude = { id: "claude", adapterType: "claude_local", model: "claude-test", binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
  const codex = { id: "codex", adapterType: "codex_local", model: "codex-test", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } };
  const policy = () => phaseRoutingSchema.parse({ enabled: true, planning: [claude, codex], implementation: [codex],
    taskOverrides: { [issueId]: { availabilityDrill: drill } } });
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("phase-availability-drill-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => database?.cleanup());
  beforeEach(async () => {
    companyId = randomUUID(); issueId = randomUUID(); agentId = randomUUID();
    drill = { id: randomUUID(), phase: "planning", profileId: "claude", expiresAt: new Date(Date.now() + 600_000).toISOString() };
    await db.insert(companies).values({ id: companyId, name: "Isolated availability test", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Existing planner", status: "idle", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Single controlled task", status: "backlog" });
  });
  const validate = (previous = null as ReturnType<typeof policy> | null) => db.transaction(tx =>
    phaseAvailabilityDrillService(tx).validateNew(companyId, policy(), previous));

  it("claims one durable diagnostic across competing resolutions and a service restart, preserving task/session data", async () => {
    await validate();
    await db.insert(agentTaskSessions).values({ companyId, agentId, taskKey: randomUUID(), adapterType: "claude_local", sessionParamsJson: { sessionId: "retained-history" } });
    const tasks = await db.select().from(issues).where(eq(issues.id, issueId));
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
    expect(await Promise.all(Array.from({ length: 8 }, () => phaseAvailabilityDrillRepository(db).apply(companyId, issueId, drill)))).toEqual(Array(8).fill("applied"));
    expect(await phaseAvailabilityDrillRepository(db).apply(companyId, issueId, drill)).toBe("applied");
    const receipts = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: drill.id, action: "phase_routing.controlled_availability_fault", entityId: issueId,
      details: { synthetic: true, providerWorkStarted: false, sharedQuotaChanged: false } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual([]);
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toEqual(tasks);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId))).toEqual(sessions);
  });
  it("does not arm a foreign task, assigned task, already-started task, or a terminal task", async () => {
    expect(await phaseAvailabilityDrillRepository(db).isUnstartedTask(randomUUID(), issueId)).toBe(false);
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await expect(validate()).rejects.toThrow("unassigned");
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, scopeKind: "issue", status: "failed" });
    await expect(validate()).rejects.toThrow("unstarted");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    expect(await phaseAvailabilityDrillRepository(db).apply(companyId, issueId, drill)).toBe("inactive");
    expect(await db.select().from(activityLog).where(eq(activityLog.id, drill.id))).toEqual([]);
  });
  it.each([-1, 1_860_000])("rejects a new out-of-window deadline %s", async remaining => {
    drill.expiresAt = new Date(Date.now() + remaining).toISOString();
    await expect(validate()).rejects.toThrow("30 minutes");
  });
  it("allows unrelated policy edits to preserve an expired existing drill, but execution fails closed", async () => {
    drill.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await expect(validate(policy())).resolves.toBeUndefined();
    expect(await phaseAvailabilityDrillService(db).apply(companyId, issueId, drill)).toBe("expired");
    expect(await phaseAvailabilityDrillRepository(db).apply(companyId, issueId, drill)).toBe("expired");
  });
  it("keeps an already activated fallback available for return after the arming deadline, until terminal", async () => {
    drill.expiresAt = new Date(Date.now() - 1_000).toISOString();
    // Retained diagnostic from an activation accepted before its deadline.
    await db.insert(activityLog).values({ id: drill.id, companyId, actorType: "system", actorId: "phase-routing",
      action: "phase_routing.controlled_availability_fault", entityType: "issue", entityId: issueId,
      details: { ...drill, synthetic: true, providerWorkStarted: false, sharedQuotaChanged: false },
      createdAt: new Date(Date.parse(drill.expiresAt) - 1_000) });
    expect(await phaseAvailabilityDrillService(db).apply(companyId, issueId, drill)).toBe("applied");
    expect(await db.select().from(activityLog).where(eq(activityLog.id, drill.id))).toHaveLength(1);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    expect(await phaseAvailabilityDrillService(db).apply(companyId, issueId, drill)).toBe("inactive");
  });
  it("recognizes unchanged configuration after a JSONB round trip even after assignment", async () => {
    await phaseRoutingSettingsRepository(db).save(companyId, policy());
    const previous = await phaseRoutingSettingsRepository(db).get(companyId);
    await db.update(issues).set({ status: "todo", assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await expect(validate(previous)).resolves.toBeUndefined();
    drill = { ...drill, id: randomUUID() };
    await expect(validate(previous)).rejects.toThrow("unassigned");
  });
  it("refuses a non-primary profile or an absent fallback", async () => {
    drill.profileId = "codex";
    await expect(validate()).rejects.toThrow("primary profile");
    drill.profileId = "claude";
    const one = policy(); one.planning = [one.planning[0]];
    await expect(phaseAvailabilityDrillService(db).validateNew(companyId, one, null)).rejects.toThrow("fallback");
  });
  it("does not accept a claim id belonging to a different operation", async () => {
    await db.insert(activityLog).values({ id: drill.id, companyId, actorId: "fixture", action: "unrelated", entityType: "issue", entityId: issueId });
    await expect(phaseAvailabilityDrillRepository(db).apply(companyId, issueId, drill)).rejects.toThrow("different operation");
    expect((await db.select().from(activityLog).where(eq(activityLog.id, drill.id)))[0].action).toBe("unrelated");
  });
});
