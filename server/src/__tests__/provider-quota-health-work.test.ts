import { afterEach, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals, signalDatabaseWork } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { registerProviderQuotaHealthWork } from "../services/provider-quota-health-work.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => { await coordinator?.stop(); vi.useRealTimers(); });
function database() {
  return installDatabaseWorkSignals({
    execute: vi.fn(async () => [{ status: "committed" }]),
    transaction: async (callback: (tx: object) => Promise<unknown>) => callback({ execute: async () => [{ xid: "1" }] }),
  });
}

it("reconstructs one health deadline and becomes quiet after recovery", async () => {
  vi.useFakeTimers();
  const owner = database(), onError = vi.fn(), deadline = Date.now() + 60_000;
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const sweep = vi.fn(async () => ({ checked: 0, recovered: 0 }));
  const worker = registerProviderQuotaHealthWork(coordinator, { sweep }, {
    next: async () => sweep.mock.calls.length < 2 ? deadline : null,
  }, () => true);
  await worker.ready;
  expect(sweep).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBe(deadline);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(sweep).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(sweep).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(sweep).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});

it("holds notifications during drain and delivers them once after admission opens", async () => {
  vi.useFakeTimers();
  let draining = true;
  const owner = database(), sweep = vi.fn(async () => ({ checked: 0, recovered: 0 })), next = vi.fn(async () => null);
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, canReconcile: () => !draining, onError: vi.fn() });
  const worker = registerProviderQuotaHealthWork(coordinator, { sweep }, { next }, () => !draining);
  await worker.ready;
  await owner.transaction(async tx => { await signalDatabaseWork(tx, DELIVERY_QUEUES.providerApiQuotaHealth); });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(sweep).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  draining = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sweep).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sweep).toHaveBeenCalledOnce();
});

it("revokes the in-flight service continuation fence when draining starts", async () => {
  vi.useFakeTimers();
  let draining = false;
  const owner = database(), next = vi.fn(async () => null);
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, onError: vi.fn() });
  const sweep = vi.fn(async (_now?: Date, canContinue?: () => boolean) => {
    expect(canContinue?.()).toBe(true);
    draining = true;
    expect(canContinue?.()).toBe(false);
    return { checked: 0, recovered: 0 };
  });
  await registerProviderQuotaHealthWork(coordinator, { sweep }, { next }, () => !draining).ready;
  expect(sweep).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
});
