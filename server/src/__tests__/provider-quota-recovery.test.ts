import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
const mocks = vi.hoisted(() => ({ list: vi.fn(), activity: vi.fn() }));
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({ list: mocks.list }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.activity }));
import { aiConnectionRoutes } from "../routes/ai-connections.js";
const companyId = "10000000-0000-4000-8000-000000000001",
  connectionId = "20000000-0000-4000-8000-000000000001";
const actor = {
  type: "board",
  source: "local_implicit",
  userId: "owner",
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "owner" }],
};
function app(identity: unknown = actor) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.actor = identity as never;
    next();
  });
  a.use("/api", aiConnectionRoutes({} as never));
  a.use(
    (
      e: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(e instanceof ZodError ? 400 : (e.status ?? 500))
        .json({ error: e.message }),
  );
  return a;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ id: connectionId }]);
  mocks.activity.mockResolvedValue(undefined);
});
describe("explicit account quota recovery", () => {
  const path = `/api/v1/companies/${companyId}/ai-connections/${connectionId}/quota-restored`;
  it("records only the selected connection, without altering receipts or starting work", async () => {
    const response = await request(app())
      .post(path)
      .send({ reason: "Owner confirmed successful API check" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connectionId,
      acknowledgedAt: expect.any(String),
    });
    expect(mocks.list).toHaveBeenCalledWith(companyId, "owner");
    expect(mocks.activity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "owner",
        entityType: "tool_connection",
        entityId: connectionId,
        action: "ai_connection.quota_recovery_acknowledged",
      }),
    );
  });
  it("requires a reason, account visibility, company access and management authority", async () => {
    expect((await request(app()).post(path).send({ reason: "" })).status).toBe(
      400,
    );
    expect(
      (
        await request(app({ type: "agent" }))
          .post(path)
          .send({ reason: "restored" })
      ).status,
    ).toBe(403);
    const viewer = {
      ...actor,
      memberships: [{ ...actor.memberships[0], membershipRole: "viewer" }],
    };
    expect(
      (await request(app(viewer)).post(path).send({ reason: "restored" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app({ ...actor, source: "session", companyIds: [] }))
          .post(path)
          .send({ reason: "restored" })
      ).status,
    ).toBe(403);
    mocks.list.mockResolvedValue([]);
    expect(
      (await request(app()).post(path).send({ reason: "restored" })).status,
    ).toBe(404);
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
