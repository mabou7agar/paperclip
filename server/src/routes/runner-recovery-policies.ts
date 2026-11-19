import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { runnerPolicyAdministration } from "../services/recovery/runner-policy-administration.js";
/** Separate protected writes; neither generic company updates nor the plugin host exposes these. */
export function runnerRecoveryPolicyRoutes(db: Db) {
  const router = Router(), service = runnerPolicyAdministration(db);
  const actor = (req: import("express").Request) => {
    if (req.actor.type === "board" && req.actor.userId) return { type: "board" as const, userId: req.actor.userId };
    if (req.actor.type === "agent" && req.actor.agentId && !req.actor.keyScope) return { type: "agent" as const, agentId: req.actor.agentId };
    throw forbidden("Protected runner policy actor required");
  };
  router.post("/companies/:companyId/runner-recovery-policies", async (req, res) => {
    const companyId = String(req.params.companyId); assertCompanyAccess(req, companyId);
    res.status(201).json(await service.register(companyId, actor(req), req.body));
  });
  for (const operation of ["activate", "revoke"] as const) router.post(`/companies/:companyId/runner-recovery-policies/:policyId/${operation}`, async (req, res) => {
    const companyId = String(req.params.companyId); assertCompanyAccess(req, companyId);
    res.json(await service[operation](companyId, actor(req), z.string().uuid().parse(req.params.policyId)));
  });
  // A separate protected CTO/board step; activation cannot call this route.
  router.put("/companies/:companyId/runner-policy-recovery", async (req, res) => {
    const companyId = String(req.params.companyId); assertCompanyAccess(req, companyId);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await service.setEnabled(companyId, actor(req), enabled); res.json({ enabled });
  });
  return router;
}
