// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PhaseRouting } from "@paperclipai/shared";
import { AgentPhaseRoutingField, PhaseRoutingField, recommendedPhaseRouting } from "./PhaseRoutingField";
import { CompanyPhaseRoutingSettings } from "./CompanyPhaseRoutingSettings";

const mocks = vi.hoisted(() => ({ models: vi.fn(), get: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { adapterModels: mocks.models } }));
vi.mock("@/api/phase-routing", () => ({ phaseRoutingApi: { get: mocks.get } }));
vi.mock("./AiConnectionField", () => ({
  aiProviderForAdapter: (adapter: string) => ({ claude_local: "anthropic", codex_local: "openai", opencode_local: "openrouter" })[adapter],
  AiConnectionField: () => <div>Connection picker</div>,
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
const common = { companyId: "company", agentId: "agent", agentName: "Worker", adapterType: "claude_local", model: "claude-current", binding: { mode: "responsible_user" as const, provider: "anthropic" as const, method: "subscription" as const } };
const changed = vi.fn();
function Editor() {
  const [policy, setPolicy] = useState(recommendedPhaseRouting());
  return <PhaseRoutingField {...common} value={policy} onChange={next => { changed(next); setPolicy(next); }} />;
}
async function settle() {
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.models.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ policy: recommendedPhaseRouting() });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
function mount(child: React.ReactNode) { flushSync(() => root.render(<QueryClientProvider client={client}>{child}</QueryClientProvider>)); }

it("supports more than five fallback levels and lets the user reorder and remove them", async () => {
  mount(<Editor />); await settle();
  for (let i = 0; i < 6; i++) {
    const add = [...container.querySelectorAll("button")].find(button => button.textContent === "Add quota fallback")!;
    flushSync(() => add.click());
  }
  expect(changed.mock.lastCall?.[0].planning).toHaveLength(8);
  const move = container.querySelector<HTMLButtonElement>('[aria-label="Move up"]')!;
  flushSync(() => move.click());
  expect(changed.mock.lastCall?.[0].planning[0].adapterType).toBe("codex_local");
  const remove = [...container.querySelectorAll("button")].find(button => button.textContent === "Remove")!;
  flushSync(() => remove.click());
  expect(changed.mock.lastCall?.[0].planning).toHaveLength(7);
});

it("starts from editable model defaults with an independent implementation chain", async () => {
  mount(<Editor />); await settle();
  const fields = container.querySelectorAll("fieldset");
  expect(fields).toHaveLength(2);
  expect(fields[0].textContent).toContain("Planning");
  expect(fields[1].textContent).toContain("Implementation");
  expect(fields[0].querySelectorAll("datalist")).toHaveLength(2);
  expect(fields[1].querySelectorAll("datalist")).toHaveLength(1);
  const input = fields[0].querySelector<HTMLInputElement>("input[list]")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.querySelectorAll("fieldset")).toHaveLength(2);
});

it("inherits company defaults and creates an explicit override on request", async () => {
  const onChange = vi.fn<(policy: PhaseRouting) => void>(), onInherit = vi.fn();
  mount(<AgentPhaseRoutingField {...common} onChange={onChange} onInherit={onInherit} />);
  await settle();
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  expect(container.textContent).toContain("Planning:");
  expect(container.querySelectorAll("fieldset")).toHaveLength(0);
  flushSync(() => checkbox.click());
  expect(onChange).toHaveBeenCalledWith(recommendedPhaseRouting());
});

it("keeps one stable company settings region through loading and cache refreshes", async () => {
  let resolve!: (value: { policy: PhaseRouting }) => void;
  mocks.get.mockReturnValue(new Promise(value => { resolve = value; }));
  mount(<CompanyPhaseRoutingSettings companyId="company" />);
  const section = container.querySelector("section");
  expect(section).not.toBeNull();
  expect(section?.textContent).toContain("Loading model defaults");
  resolve({ policy: recommendedPhaseRouting() }); await settle();
  expect(container.querySelectorAll("section")).toHaveLength(1);
  expect(container.querySelector("section")).toBe(section);
  expect(section?.textContent).not.toContain("Loading model defaults");
  for (let i = 0; i < 3; i++) {
    flushSync(() => client.setQueryData(["phase-routing", "company"], {
      policy: { ...recommendedPhaseRouting(), unknownResetCooldownSeconds: 3601 + i },
    }));
    await settle();
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(container.querySelector("section")).toBe(section);
  }
});
