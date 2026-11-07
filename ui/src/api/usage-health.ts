import type { UsageHealthPolicy, UsageHealthReport } from "@paperclipai/shared";
import { api } from "./client";
export const usageHealthApi = {
  report(companyId: string, from?: string, to?: string) {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    return api.get<UsageHealthReport>(
      `/v1/companies/${companyId}/usage-health?${query}`,
    );
  },
  save(companyId: string, policy: UsageHealthPolicy) {
    return api.put<{ policy: UsageHealthPolicy }>(
      `/v1/companies/${companyId}/usage-health/policy`,
      policy,
    );
  },
};
