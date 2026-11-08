import type { PhaseRouting, ConnectionUsageCapStatus } from "@paperclipai/shared";
import { api } from "./client";

const path = (companyId: string) => `/v1/companies/${encodeURIComponent(companyId)}/phase-routing`;
export const phaseRoutingApi = {
  usage: (companyId:string) => api.get<{connections:ConnectionUsageCapStatus[]}>(path(companyId)+"/usage"),
  get: (companyId: string) => api.get<{ policy: PhaseRouting | null }>(path(companyId)),
  save: (companyId: string, policy: PhaseRouting) => api.put<{ policy: PhaseRouting }>(path(companyId), policy),
};
