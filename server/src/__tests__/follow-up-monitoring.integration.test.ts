import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, documents, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { followUpMonitoring } from "../services/follow-up-monitoring.js";
import { monitoringService, settleMonitoringOwnerNudges } from "../services/monitoring.js";

const register = `| ID | Gap | State |
|----|-----|-------|
| G1 | Safari lesson player | NOT TESTED |
| G2 | xAPI replay | PARTIAL |
| G3 | Rewards flag | BLOCKED |
| G4 | Pagination | Done |`;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("follow-up monitoring with real PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("follow-up-monitoring-"); db = createDb(database.connectionString); }, 90000);
  afterEach(async () => { await settleMonitoringOwnerNudges(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(options: { status?: string; assigned?: boolean; escalation?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), ctoId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Follow-ups", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", status: "idle", adapterType: "process", adapterConfig: {} },
      { id: ctoId, companyId, name: "CTO", role: "cto", status: "idle", adapterType: "process", adapterConfig: {} },
    ]);
    if (options.escalation) await db.update(companies).set({ defaultReviewEscalationAgentId: ctoId }).where(eq(companies.id, companyId));
    await db.insert(issues).values({ id: issueId, companyId, title: "OSA-474 rewards", status: options.status ?? "done",
      assigneeAgentId: options.assigned === false ? null : agentId });
    await monitoringService(db).savePolicy(companyId, { mode: "alert_only" }, "owner");
    return { companyId, agentId, ctoId, issueId };
  }
  async function addDocument(f: { companyId: string; issueId: string; agentId?: string }, title: string, body: string) {
    const id = randomUUID();
    await db.insert(documents).values({ id, companyId: f.companyId, title, latestBody: body, latestRevisionId: randomUUID(),
      updatedByAgentId: (f as { agentId?: string }).agentId ?? null });
    await db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issueId, documentId: id, key: `doc-${id.slice(0, 6)}` });
    return id;
  }
  const alerts = (companyId: string, kind: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
    eq(activityLog.action, "monitoring.alert"), sql`${activityLog.details} ->> 'kind' = ${kind}`));

  it("reports untracked register items of a closed task once and wakes its assignee with the items", async () => {
    const f = await seed();
    await addDocument(f, "OSA-474 closure and flag-enable gap register", register);
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    const observation = await followUpMonitoring(db, { wakeup }).checkClosedIssue(f.companyId, f.issueId);
    await settleMonitoringOwnerNudges();
    expect(observation?.kind).toBe("untracked_follow_ups");
    expect(await alerts(f.companyId, "untracked_follow_ups")).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, options] = wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown>; payload: Record<string, unknown> }];
    expect(agentId).toBe(f.agentId);
    expect(options.payload).toMatchObject({ issueId: f.issueId, monitoringAlertKind: "untracked_follow_ups" });
    expect(String(options.contextSnapshot.livenessContinuationInstruction)).toMatch(/3 open items.*G1.*G2.*G3.*owner question card/s);
    // Observed again: no second alert or wake.
    await followUpMonitoring(db, { wakeup }).checkClosedIssue(f.companyId, f.issueId);
    await settleMonitoringOwnerNudges();
    expect(await alerts(f.companyId, "untracked_follow_ups")).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("wakes the company escalation agent when the closed task has no assignee", async () => {
    const f = await seed({ assigned: false, escalation: true });
    await addDocument(f, "Gap register", register);
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    await followUpMonitoring(db, { wakeup }).checkClosedIssue(f.companyId, f.issueId);
    await settleMonitoringOwnerNudges();
    expect(wakeup.mock.calls.map(call => (call as unknown[])[0])).toEqual([f.ctoId]);
  });

  it("stays quiet when child tasks track the items, for open tasks, and for documents without a register", async () => {
    const tracked = await seed();
    await addDocument(tracked, "Gap register", register);
    await db.insert(issues).values(["G1 Safari retest", "G2 xAPI replay", "G3 rewards flag"].map(title =>
      ({ companyId: tracked.companyId, parentId: tracked.issueId, title, status: "todo" })));
    const open = await seed({ status: "in_progress" });
    await addDocument(open, "Gap register", register);
    const plain = await seed();
    await addDocument(plain, "Release notes", register);
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    for (const f of [tracked, open, plain]) {
      expect(await followUpMonitoring(db, { wakeup }).checkClosedIssue(f.companyId, f.issueId)).toBeNull();
    }
    await settleMonitoringOwnerNudges();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("reports an owner decision with no question card once, and wakes the assignee to raise one", async () => {
    const f = await seed({ status: "in_progress" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      body: "Options A and B are ready. The owner decides which one ships." });
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    const observation = await followUpMonitoring(db, { wakeup }).checkOwnerDecision(f.companyId, f.issueId);
    await settleMonitoringOwnerNudges();
    expect(observation).toMatchObject({ kind: "owner_decision_without_card", details: { phrase: "The owner decides" } });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, options] = wakeup.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }];
    expect(agentId).toBe(f.agentId);
    expect(String(options.contextSnapshot.livenessContinuationInstruction)).toContain("Raise one owner question card");
    await followUpMonitoring(db, { wakeup }).checkOwnerDecision(f.companyId, f.issueId);
    await settleMonitoringOwnerNudges();
    expect(await alerts(f.companyId, "owner_decision_without_card")).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a card was raised after the text, a card is pending on the parent, or a person wrote it", async () => {
    const asked = await seed({ status: "in_progress" });
    await db.insert(issueComments).values({ companyId: asked.companyId, issueId: asked.issueId, authorAgentId: asked.agentId,
      body: "Awaiting owner approval.", createdAt: new Date(Date.now() - 60_000) });
    await db.insert(issueThreadInteractions).values({ companyId: asked.companyId, issueId: asked.issueId, kind: "ask_user_questions",
      status: "answered", payload: { version: 1, questions: [] } as never });
    const parentPending = await seed({ status: "blocked" });
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId: parentPending.companyId, title: "Parent", status: "in_progress" });
    await db.update(issues).set({ parentId }).where(eq(issues.id, parentPending.issueId));
    await db.insert(issueThreadInteractions).values({ companyId: parentPending.companyId, issueId: parentId, kind: "ask_user_questions",
      status: "pending", payload: { version: 1, questions: [] } as never, createdAt: new Date(Date.now() - 3_600_000) });
    await addDocument(parentPending, "Plan", "## Decision\n\nThe owner decides between the two tenants.");
    const human = await seed({ status: "in_progress" });
    await db.insert(issueComments).values({ companyId: human.companyId, issueId: human.issueId, authorUserId: "owner",
      body: "The owner decides this one, I'll come back to it." });
    const wakeup = vi.fn(async () => ({ id: randomUUID() }));
    for (const f of [asked, parentPending, human]) {
      expect(await followUpMonitoring(db, { wakeup }).checkOwnerDecision(f.companyId, f.issueId)).toBeNull();
    }
    await settleMonitoringOwnerNudges();
    expect(wakeup).not.toHaveBeenCalled();
  });
});
