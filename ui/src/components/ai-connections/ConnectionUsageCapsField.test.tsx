// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PhaseRouting } from "@paperclipai/shared";
import { ConnectionUsageCapsField } from "./ConnectionUsageCapsField";
const mocks = vi.hoisted(() => ({ list: vi.fn(), usage: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: { list: mocks.list },
}));
vi.mock("@/api/phase-routing", () => ({
  phaseRoutingApi: { usage: mocks.usage },
}));
async function act(action: () => void | Promise<void>) {
  let result: void | Promise<void>;
  flushSync(() => {
    result = action();
  });
  await result!;
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}
let root: Root, host: HTMLDivElement, latest: PhaseRouting;
const first = "10000000-0000-4000-8000-000000000001",
  second = "10000000-0000-4000-8000-000000000002";
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.list.mockResolvedValue({
    connections: [
      { id: first, name: "Subscription", status: "connected" },
      { id: second, name: "Claude API", status: "connected" },
    ],
  });
  mocks.usage.mockResolvedValue({ connections: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
async function mount() {
  function Form() {
    const [value, setValue] = useState({
      enabled: false,
      planning: [],
      implementation: [],
      unknownResetCooldownSeconds: 0,
    } as PhaseRouting);
    latest = value;
    return (
      <ConnectionUsageCapsField
        companyId="company"
        value={value}
        onChange={setValue}
      />
    );
  }
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Form />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
async function input(index: number, value: string) {
  const element = host.querySelectorAll('input[type="number"]')[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("starts without numeric caps and keeps token and USD caps independent", async () => {
  await mount();
  expect(host.querySelectorAll('input[type="number"]')).toHaveLength(6);
  expect(latest.connectionUsageCaps).toBeUndefined();
  await input(0, "1000");
  await input(1, "2.50");
  expect(latest.connectionUsageCaps?.[first].rolling5h).toEqual({
    tokens: 1000,
    apiCostUsd: "2.50",
  });
  await input(1, "");
  expect(latest.connectionUsageCaps?.[first].rolling5h?.tokens).toBe(1000);
  await input(0, "");
  expect(latest.connectionUsageCaps?.[first]).toBeUndefined();
});
it("retains separate limits for each connection and rolling window", async () => {
  await mount();
  await input(2, "3000");
  await act(async () => {
    const select = host.querySelector("select")!;
    select.value = second;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await input(4, "5000");
  expect(latest.connectionUsageCaps?.[first].daily?.tokens).toBe(3000);
  expect(latest.connectionUsageCaps?.[second].weekly?.tokens).toBe(5000);
  expect(latest.connectionUsageCaps?.[second].daily).toBeUndefined();
});
it("keeps unknown usage report-only until an explicit hold is selected", async () => {
  await mount();
  const checkbox=host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(false);
  await input(3,"2.50");
  await act(async()=>{checkbox.click();});
  expect(latest.connectionUsageCaps?.[first]).toMatchObject({onUnknownUsage:"hold",daily:{apiCostUsd:"2.50"}});
  await act(async()=>{checkbox.click();});
  expect(latest.connectionUsageCaps?.[first]).toMatchObject({onUnknownUsage:"report",daily:{apiCostUsd:"2.50"}});
});
