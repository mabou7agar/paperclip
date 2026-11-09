import express from "express";
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { phaseRoutingSchema } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), company: vi.fn(), manage: vi.fn(), activity: vi.fn() }));
vi.mock("../services/phase-routing.js", () => ({ phaseRoutingService: () => ({ getCompanyDefaults: mocks.get, saveCompanyDefaults: mocks.save }) }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({ getById: mocks.company }) }));
vi.mock("../routes/ai-connections.js", () => ({ canManageAiConnections: mocks.manage }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.activity }));
import { phaseRoutingRoutes } from "../routes/phase-routing.js";

const policy = phaseRoutingSchema.parse({ enabled: true, planning: [{ id: "claude", adapterType: "claude_local", model: "claude-model", binding: { mode: "responsible_user", provider: "anthropic", method: "subscription" } }], implementation: [{ id: "codex", adapterType: "codex_local", model: "codex-model", binding: { mode: "responsible_user", provider: "openai", method: "subscription" } }] });
function app(actor = { type: "board", source: "session", userId: "user", companyIds: ["company"], memberships: [{ companyId: "company", status: "active", membershipRole: "owner" }] }) {
  const application = express();
  application.use(express.json());
  application.use((req, _res, next) => { req.actor = actor as never; next(); });
  application.use("/api", phaseRoutingRoutes({} as never));
  application.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ error: error.message });
  });
  return application;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(policy);
  mocks.save.mockImplementation(async input => input.policy);
  mocks.company.mockResolvedValue({ id: "company" });
  mocks.manage.mockResolvedValue(true);
});

describe("versioned phase routing API", () => {
  const path = "/api/v1/companies/company/phase-routing";
  it("returns and validates company-scoped defaults", async () => {
    expect((await request(app()).get(path)).body).toEqual({ policy });
    const response = await request(app()).put(path).send(policy);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ policy });
    expect(mocks.save).toHaveBeenCalledWith({ companyId: "company", userId: "user", policy });
    expect(mocks.activity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "company.phase_routing_updated" }));
    expect((await request(app()).put(path).send({ ...policy, planning: [] })).status).toBe(400);
  });
  it("round-trips task exceptions through the existing board-only policy API", async () => {
    const scoped = { ...policy, taskOverrides: { "30000000-0000-4000-8000-000000000001": { review: policy.planning } } };
    const response = await request(app()).put(path).send(scoped);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ policy: scoped });
    expect((await request(app({ type: "agent" } as never)).put(path).send(scoped)).status).toBe(403);
  });
  it("rejects foreign-company, agent, and insufficient-permission mutations", async () => {
    expect((await request(app()).get("/api/v1/companies/foreign/phase-routing")).status).toBe(403);
    expect((await request(app({ type: "agent" } as never)).get(path)).status).toBe(403);
    mocks.manage.mockResolvedValue(false);
    expect((await request(app()).put(path).send(policy)).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("checks real HTTP payloads with curl without contacting providers", async () => {
    const server = app().listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}${path}`;
    const curl = promisify(execFile);
    try {
      const get = await curl("curl", ["--fail-with-body", "--silent", "--show-error", url]);
      expect(JSON.parse(get.stdout)).toEqual({ policy });
      const put = await curl("curl", ["--fail-with-body", "--silent", "--show-error", "--request", "PUT", "--header", "Content-Type: application/json", "--data-binary", JSON.stringify({ ...policy, review: policy.planning, defaultResponsibility: "implementation", roleResponsibilities: { cto: "planning" }, taskOverrides: { "30000000-0000-4000-8000-000000000001": { review: policy.planning } } }), url]);
      expect(JSON.parse(put.stdout)).toEqual({ policy: { ...policy, review: policy.planning, defaultResponsibility: "implementation", roleResponsibilities: { cto: "planning" }, taskOverrides: { "30000000-0000-4000-8000-000000000001": { review: policy.planning } } } });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
