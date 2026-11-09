import { z } from "zod";

/** Automatic preserves the existing behavior for companies without a policy. */
export const monitoringPolicySchema = z.object({
  mode: z.enum(["automatic", "alert_only"]).default("automatic"),
}).strict();
export type MonitoringPolicy = z.infer<typeof monitoringPolicySchema>;
export type MonitoringObservation = {
  companyId: string;
  issueId: string;
  kind: "missing_disposition" | "dependency_ready" | "no_execution_path" | "monitor_due" | "stopped_subtree";
  fingerprint: string;
};
