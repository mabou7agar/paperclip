import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  usageHealthPolicySchema,
  usageHealthQuerySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { accessService } from "../services/access.js";
import { usageHealthService } from "../services/usage-health.js";
import { forbidden } from "../errors.js";

export function usageHealthRoutes(db: Db) {
  const router = Router(),
    service = usageHealthService(db),
    access = accessService(db);
  router.use(
    "/v1/companies/:companyId/usage-health",
    async (req, _res, next) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const decision = await access.decide({
        actor: req.actor,
        action: "company_scope:read",
        resource: { type: "company", companyId },
      });
      if (!decision.allowed)
        throw forbidden(
          "Costs are outside this actor's authorization boundary",
        );
      next();
    },
  );
  router.get("/v1/companies/:companyId/usage-health", async (req, res) => {
    const companyId = req.params.companyId as string,
      input = usageHealthQuerySchema.parse(req.query);
    const viewer = req.actor.memberships?.some(
      (m) => m.companyId === companyId && m.membershipRole === "viewer",
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await service.report(
        companyId,
        input.from ? new Date(input.from) : new Date(0),
        input.to ? new Date(input.to) : new Date(),
        !viewer && (await canManageAiConnections(db, req, companyId)),
      ),
    );
  });
  router.put(
    "/v1/companies/:companyId/usage-health/policy",
    validate(usageHealthPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (
        req.actor.memberships?.some(
          (m) => m.companyId === companyId && m.membershipRole === "viewer",
        ) ||
        !(await canManageAiConnections(db, req, companyId))
      )
        throw forbidden(
          "Company administration is required to change usage alerts",
        );
      res.json({
        policy: await service.savePolicy(
          companyId,
          req.body,
          getActorInfo(req).actorId,
        ),
      });
    },
  );
  return router;
}
