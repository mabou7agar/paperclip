import express from "express";
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { usageHealthPolicySchema } from "@paperclipai/shared";
const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  save: vi.fn(),
  access: vi.fn(),
  manage: vi.fn(),
}));
vi.mock("../services/usage-health.js", () => ({
  usageHealthService: () => ({ report: mocks.report, savePolicy: mocks.save }),
}));
vi.mock("../services/access.js", () => ({
  accessService: () => ({ decide: mocks.access }),
}));
vi.mock("../routes/ai-connections.js", () => ({
  canManageAiConnections: mocks.manage,
}));
import { usageHealthRoutes } from "../routes/usage-health.js";
const policy = usageHealthPolicySchema.parse({ enabled: true });
const actor = {
  type: "board",
  source: "session",
  userId: "user",
  companyIds: ["company"],
  memberships: [
    { companyId: "company", status: "active", membershipRole: "owner" },
  ],
};
function app(identity: unknown = actor) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.actor = identity as never;
    next();
  });
  a.use("/api", usageHealthRoutes({} as never));
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
  mocks.access.mockResolvedValue({ allowed: true });
  mocks.manage.mockResolvedValue(true);
  mocks.report.mockResolvedValue({ policy, totals: { totalTokens: 310 } });
  mocks.save.mockImplementation(async (_company, p) => p);
});
describe("usage health API", () => {
  const path = "/api/v1/companies/company/usage-health";
  it("returns metadata with no-store and validates date ranges", async () => {
    expect((await request(app()).get(path)).headers["cache-control"]).toBe(
      "no-store",
    );
    expect((await request(app()).get(path + "?from=invalid")).status).toBe(400);
    expect(
      (await request(app()).get(path + "?from=2026-11-08&to=2026-11-07"))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app())
          .put(path + "/policy")
          .send({
            ...policy,
            thresholds: { ...policy.thresholds, runsPerTaskHour: 0 },
          })
      ).status,
    ).toBe(400);
  });
  it("keeps company, actor and administration boundaries", async () => {
    expect((await request(app({ type: "agent" })).get(path)).status).toBe(403);
    expect(
      (await request(app()).get("/api/v1/companies/foreign/usage-health"))
        .status,
    ).toBe(403);
    mocks.access.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(path)).status).toBe(403);
    mocks.access.mockResolvedValue({ allowed: true });
    const viewer = {
      ...actor,
      memberships: [{ ...actor.memberships[0], membershipRole: "viewer" }],
    };
    expect((await request(app(viewer)).get(path)).status).toBe(200);
    expect(mocks.report).toHaveBeenLastCalledWith(
      "company",
      expect.any(Date),
      expect.any(Date),
      false,
    );
    expect(
      (
        await request(app(viewer))
          .put(path + "/policy")
          .send(policy)
      ).status,
    ).toBe(403);
    mocks.manage.mockResolvedValue(false);
    expect(
      (
        await request(app())
          .put(path + "/policy")
          .send(policy)
      ).status,
    ).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("checks real curl payloads and preserves structured per-agent overrides", async () => {
    const server = app().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
    const curl = promisify(execFile),
      scoped = {
        ...policy,
        agentOverrides: {
          "20000000-0000-4000-8000-000000000001": { runsPerTaskHour: 4 },
        },
      };
    try {
      const get = await curl("curl", ["--fail-with-body", "-sS", url]);
      expect(JSON.parse(get.stdout).totals.totalTokens).toBe(310);
      const put = await curl("curl", [
        "--fail-with-body",
        "-sS",
        "-X",
        "PUT",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        JSON.stringify(scoped),
        url + "/policy",
      ]);
      expect(JSON.parse(put.stdout)).toEqual({ policy: scoped });
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});
