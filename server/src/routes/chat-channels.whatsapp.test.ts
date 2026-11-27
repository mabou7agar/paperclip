import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";

// The management guard and permission lookup read the database; this test
// covers the WhatsApp routes' own company and permission checks on top of it.
const access = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => access }));
vi.mock("./connection-management-authz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection-management-authz.js")>()),
  connectionManagementGuard: () => () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const settings = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => settings }));

const { chatChannelRoutes } = await import("./chat-channels.js");

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const linkView = { state: "qr", qrPngDataUrl: "data:image/png;base64,AAAA", endpointStatus: "draft" };

function fixture(actor: Request["actor"]) {
  const service = {
    get: vi.fn().mockResolvedValue({ id: ENDPOINT_ID, companyId: "company-a", provider: "whatsapp" }),
    startWhatsAppLink: vi.fn().mockResolvedValue(linkView),
    whatsAppLinkStatus: vi.fn().mockResolvedValue({ ...linkView, state: "linked", linkedAs: "+4915550001", endpointStatus: "verifying" }),
    unlinkWhatsApp: vi.fn().mockResolvedValue({ state: "logged_out", endpointStatus: "attention" }),
    whatsAppKnownPeople: vi.fn().mockResolvedValue({ people: [{ phone: "4915550001", paperclipUserId: "user-1" }] }),
    replaceWhatsAppKnownPeople: vi.fn().mockImplementation(async (_id: string, body: { people: unknown[] }) => ({ people: body.people })),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", chatChannelRoutes({} as Db, { service: service as unknown as ChatChannelService, heartbeat: { wakeup: vi.fn() } }));
  app.use(errorHandler);
  return { app, service };
}

const manager: Request["actor"] = { type: "board", source: "session", userId: "manager", companyIds: ["company-a"] };
const outsider: Request["actor"] = { type: "board", source: "session", userId: "outsider", companyIds: ["company-b"] };
const agent = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" } as unknown as Request["actor"];

beforeEach(() => {
  access.hasPermission.mockReset();
  settings.getExperimental.mockResolvedValue({ enableChatConnectors: true });
});

describe("WhatsApp link routes", () => {
  it("lets a connection manager start linking, poll and unlink, without caching", async () => {
    access.hasPermission.mockResolvedValue(true);
    const f = fixture(manager);
    const started = await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "qr" }).expect(200);
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(started.body).toEqual(linkView);
    expect(f.service.startWhatsAppLink).toHaveBeenCalledWith(ENDPOINT_ID, { mode: "qr" });

    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "code", phone: "+49 155 50001" }).expect(200);
    expect(f.service.startWhatsAppLink).toHaveBeenLastCalledWith(ENDPOINT_ID, { mode: "code", phone: "+49 155 50001" });

    const status = await request(f.app).get(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link-status`).expect(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.body.linkedAs).toBe("+4915550001");
    expect(f.service.whatsAppLinkStatus).toHaveBeenCalledWith(ENDPOINT_ID, "manager", undefined);

    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/unlink`).send({}).expect(200);
    expect(f.service.unlinkWhatsApp).toHaveBeenCalledWith(ENDPOINT_ID);
  });

  it("rejects invalid link requests before reaching the service", async () => {
    access.hasPermission.mockResolvedValue(true);
    const f = fixture(manager);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "sms" }).expect(400);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "code" }).expect(400);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "code", phone: "call me" }).expect(400);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "qr", phone: "+4915550001" }).expect(400);
    expect(f.service.startWhatsAppLink).not.toHaveBeenCalled();
  });

  it("hides another company's channel", async () => {
    const f = fixture(outsider);
    await request(f.app).get(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link-status`).expect(404);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "qr" }).expect(404);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/unlink`).send({}).expect(404);
    expect(f.service.whatsAppLinkStatus).not.toHaveBeenCalled();
    expect(f.service.startWhatsAppLink).not.toHaveBeenCalled();
    expect(f.service.unlinkWhatsApp).not.toHaveBeenCalled();
  });

  it("requires the connection-management permission in the company", async () => {
    access.hasPermission.mockResolvedValue(false);
    const f = fixture(manager);
    await request(f.app).get(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link-status`).expect(403);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "qr" }).expect(403);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/unlink`).send({}).expect(403);
    expect(access.hasPermission).toHaveBeenCalledWith("company-a", "user", "manager", "tools:manage_connections");
    expect(f.service.whatsAppLinkStatus).not.toHaveBeenCalled();
    expect(f.service.unlinkWhatsApp).not.toHaveBeenCalled();
  });

  it("refuses agents: linking is for people only", async () => {
    access.hasPermission.mockResolvedValue(true);
    const f = fixture(agent);
    await request(f.app).get(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link-status`).expect(403);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/link`).send({ mode: "qr" }).expect(403);
    await request(f.app).post(`/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/unlink`).send({}).expect(403);
    expect(f.service.whatsAppLinkStatus).not.toHaveBeenCalled();
    expect(f.service.startWhatsAppLink).not.toHaveBeenCalled();
    expect(f.service.unlinkWhatsApp).not.toHaveBeenCalled();
  });
});

describe("WhatsApp pre-approved people routes", () => {
  const url = `/api/chat-endpoints/${ENDPOINT_ID}/whatsapp/known-people`;

  it("lets a connection manager read and replace the list, without caching", async () => {
    access.hasPermission.mockResolvedValue(true);
    const f = fixture(manager);
    const listed = await request(f.app).get(url).expect(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.body.people).toHaveLength(1);
    const people = [{ phone: "+4915550001", paperclipUserId: "user-1" }, { phone: "4915550002", paperclipUserId: "user-2" }];
    await request(f.app).put(url).send({ people }).expect(200);
    expect(f.service.replaceWhatsAppKnownPeople).toHaveBeenCalledWith(ENDPOINT_ID, { people }, "manager");
  });

  it("validates the list before reaching the service", async () => {
    access.hasPermission.mockResolvedValue(true);
    const f = fixture(manager);
    await request(f.app).put(url).send({ people: [{ phone: "call me", paperclipUserId: "u" }] }).expect(400);
    await request(f.app).put(url).send({ people: [{ phone: "4915550001" }] }).expect(400);
    await request(f.app).put(url).send({ people: [{ phone: "4915550001", paperclipUserId: "u", role: "owner" }] }).expect(400);
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ phone: `49155${String(index).padStart(5, "0")}`, paperclipUserId: "u" }));
    await request(f.app).put(url).send({ people: tooMany }).expect(400);
    expect(f.service.replaceWhatsAppKnownPeople).not.toHaveBeenCalled();
  });

  it("refuses agents, outsiders and members without the permission", async () => {
    access.hasPermission.mockResolvedValue(true);
    const asAgent = fixture(agent);
    await request(asAgent.app).get(url).expect(403);
    await request(asAgent.app).put(url).send({ people: [] }).expect(403);
    const asOutsider = fixture(outsider);
    await request(asOutsider.app).get(url).expect(404);
    access.hasPermission.mockResolvedValue(false);
    const denied = fixture(manager);
    await request(denied.app).put(url).send({ people: [] }).expect(403);
    for (const f of [asAgent, asOutsider, denied]) {
      expect(f.service.whatsAppKnownPeople).not.toHaveBeenCalled();
      expect(f.service.replaceWhatsAppKnownPeople).not.toHaveBeenCalled();
    }
  });
});
