import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { phaseRoutingSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden, notFound } from "../errors.js";
import { companyService } from "../services/companies.js";
import { phaseRoutingService } from "../services/phase-routing.js";
import { logActivity } from "../services/activity-log.js";
import { connectionUsageCapsService } from "../services/connection-usage-caps.js";

export function phaseRoutingRoutes(
  db: Db,
  onPolicySaved?: (companyId: string) => Promise<unknown>,
) {
  const router = Router();
  const service = phaseRoutingService(db);
  const companies = companyService(db);
  router.get(
    "/v1/companies/:companyId/phase-routing/usage",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!(await canManageAiConnections(db, req, companyId)))
        throw forbidden(
          "Connection management permission is required to view connection caps",
        );
      if (!(await companies.getById(companyId)))
        throw notFound("Company not found");
      res.json({
        connections: await connectionUsageCapsService(db).report(companyId),
      });
    },
  );
  router.get("/v1/companies/:companyId/phase-routing", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (!(await companies.getById(companyId)))
      throw notFound("Company not found");
    res.json({ policy: await service.getCompanyDefaults(companyId) });
  });
  router.put(
    "/v1/companies/:companyId/phase-routing",
    validate(phaseRoutingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!(await canManageAiConnections(db, req, companyId)))
        throw forbidden(
          "Connection management permission is required to change company routing",
        );
      if (!(await companies.getById(companyId)))
        throw notFound("Company not found");
      const actor = getActorInfo(req);
      const policy = await service.saveCompanyDefaults({
        companyId,
        userId: actor.actorId,
        policy: req.body,
      });
      await logActivity(db, {
        companyId,
        ...actor,
        action: "company.phase_routing_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          enabled: policy.enabled,
          planningLevels: policy.planning.length,
          implementationLevels: policy.implementation.length,
          reviewLevels: policy.review?.length ?? 0,
          defaultResponsibility: policy.defaultResponsibility,
          roleResponsibilities: policy.roleResponsibilities,
          taskOverrideIds: Object.keys(policy.taskOverrides ?? {}),
          apiQuotaRecheckSeconds: policy.apiQuotaRecheckSeconds ?? 0,
          apiQuotaRecheckOverrides: policy.apiQuotaRecheckOverrides ?? {},
          connectionUsageCaps: policy.connectionUsageCaps ?? {},
        },
      });
      res.json({ policy });
      if (onPolicySaved) void onPolicySaved(companyId).catch(() => undefined);
    },
  );
  return router;
}
