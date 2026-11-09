import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { providerQuotaProbeService } from "./provider-quota-probes.js";
import type { providerQuotaHealthSchedule } from "./provider-quota-health-schedule.js";

/** Account claims bound provider I/O; this worker only owns its wake deadline. */
export function registerProviderQuotaHealthWork(
  coordinator: Parameters<typeof registerDeadlineWork>[0],
  service: Pick<ReturnType<typeof providerQuotaProbeService>, "sweep">,
  schedule: Pick<ReturnType<typeof providerQuotaHealthSchedule>, "next">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.providerApiQuotaHealth, {
    retryMs: 30_000,
    minimumSpacingMs: 30_000,
    canRun,
    run: signal => service.sweep(undefined, () => !signal.aborted && canRun()),
    next: () => schedule.next(),
  });
}
