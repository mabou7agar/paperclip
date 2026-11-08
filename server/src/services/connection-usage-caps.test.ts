import { expect, it } from "vitest";
import { connectionUsageCapsSchema } from "@paperclipai/shared";
import { evaluateConnectionUsageCaps } from "./connection-usage-caps.js";
const now = new Date("2026-11-08T10:00:00Z");
const row = (
  hours: number,
  tokens: number | null,
  apiCostCents: string | null = "0",
) => ({ at: new Date(now.getTime() - hours * 3600000), tokens, apiCostCents });
it("leaves every cap optional and validates positive exact USD amounts", () => {
  expect(connectionUsageCapsSchema.parse({})).toEqual({});
  for (const value of [
    { daily: { tokens: 0 } },
    { weekly: { tokens: -1 } },
    { daily: { apiCostUsd: "0" } },
    { daily: { apiCostUsd: "1e2" } },
    { daily: { apiCostUsd: "NaN" } },
  ])
    expect(connectionUsageCapsSchema.safeParse(value).success).toBe(false);
  expect(
    connectionUsageCapsSchema.parse({
      rolling5h: { apiCostUsd: "0.000001" },
      weekly: { tokens: 100 },
    }),
  ).toBeDefined();
});
it("uses exact rolling boundaries and renews only after enough usage expires", () => {
  const result = evaluateConnectionUsageCaps(
    "account",
    { rolling5h: { tokens: 100 } },
    [row(5, 999), row(4, 60), row(1, 60), row(-1, 999)],
    now,
  );
  expect(result.windows[0].tokens).toBe(120);
  expect(result.retryAt).toBe("2026-11-08T11:00:00.000Z");
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { rolling5h: { tokens: 100 } },
      [row(4, 60), row(1, 60)],
      new Date(result.retryAt!),
    ).blocked,
  ).toBe(false);
});
it("waits for every exceeded window, rather than waking at the first reset", () => {
  const result = evaluateConnectionUsageCaps(
    "account",
    {
      rolling5h: { tokens: 100 },
      daily: { tokens: 100 },
      weekly: { tokens: 100 },
    },
    [row(1, 100)],
    now,
  );
  expect(result.windows.every((w) => w.blocked)).toBe(true);
  expect(result.retryAt).toBe("2026-11-15T09:00:00.000Z");
});
it("compares fractional API costs without floating point rounding", () => {
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { daily: { apiCostUsd: "0.000001" } },
      [row(1, 0, "0.00005"), row(1, 0, "0.00005")],
      now,
    ).blocked,
  ).toBe(true);
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { daily: { apiCostUsd: "0.000002" } },
      [row(1, 0, "0.0001")],
      now,
    ).blocked,
  ).toBe(false);
});
it("holds unknown usage only for the metric whose cap is enabled", () => {
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { daily: { tokens: 100 } },
      [row(1, 10, null)],
      now,
    ).blocked,
  ).toBe(false);
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { daily: { apiCostUsd: "1" } },
      [row(1, null, "10")],
      now,
    ).blocked,
  ).toBe(false);
  const result = evaluateConnectionUsageCaps(
    "account",
    { onUnknownUsage: "hold", daily: { apiCostUsd: "1" } },
    [row(1, 10, null)],
    now,
  );
  expect(result.windows[0].apiCostUsd).toBeNull();
  expect(result.blocked).toBe(true);
  expect(result.retryAt).toBe("2026-11-09T09:00:00.000Z");
});

it("reports unknown amounts by default while enforcing the known minimum spend", () => {
  const result = evaluateConnectionUsageCaps(
    "account",
    { daily: { apiCostUsd: "1" } },
    [row(1, 10, null)],
    now,
  );
  expect(result.blocked).toBe(false);
  expect(result.windows[0].apiCostUsd).toBeNull();
  expect(result.windows[0].knownApiCostUsd).toBe("0.000000000");
  expect(
    evaluateConnectionUsageCaps(
      "account",
      { daily: { apiCostUsd: "1" } },
      [row(1, 10, null), row(1, 10, "100")],
      now,
    ).blocked,
  ).toBe(true);
});
