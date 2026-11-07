import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { monitoringPolicySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { monitoringService } from "../services/monitoring.js";

export function monitoringRoutes(db: Db) {
  const router = Router(), service = monitoringService(db);
  const path = "/v1/companies/:companyId/monitoring";
  router.use(path, (req, _res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    next();
  });
  router.get("/v1/companies/:companyId/monitoring", async (req, res) => {
    const companyId = req.params.companyId as string;
    res.setHeader("Cache-Control", "no-store");
    res.json({ policy: await service.policy(companyId), alerts: await service.alerts(companyId) });
  });
  router.put("/v1/companies/:companyId/monitoring", validate(monitoringPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin && !req.actor.memberships?.some(m => m.companyId === companyId && m.status === "active" && ["owner", "admin"].includes(m.membershipRole ?? "")))
      throw forbidden("Company administration is required to change monitoring");
    res.json({ policy: await service.savePolicy(companyId, req.body, getActorInfo(req).actorId) });
  });
  return router;
}
