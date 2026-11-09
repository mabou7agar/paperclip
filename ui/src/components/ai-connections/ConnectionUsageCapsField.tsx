import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  connectionUsageWindowSchema,
  type ConnectionUsageCaps,
  type ConnectionUsageWindow,
  type PhaseRouting,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { phaseRoutingApi } from "@/api/phase-routing";
import { useTranslation } from "@/i18n";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";

const labels = {
  rolling5h: "capRolling5h",
  daily: "capDaily",
  weekly: "capWeekly",
} as const;
export function ConnectionUsageCapsField({
  companyId,
  value,
  onChange,
}: {
  companyId: string;
  value: PhaseRouting;
  onChange: (value: PhaseRouting) => void;
}) {
  const { t } = useTranslation("phaseRouting");
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId),
  });
  const usage = useQuery({
    queryKey: ["phase-routing-usage", companyId],
    queryFn: () => phaseRoutingApi.usage(companyId),
  });
  const [chosen, setChosen] = useState("");
  const connections = [
    ...new Map(
      (accounts.data?.connections ?? [])
        .filter(
          (c) => c.status === "connected" || value.connectionUsageCaps?.[c.id],
        )
        .map((c) => [c.id, c]),
    ).values(),
  ];
  const id = connections.some((c) => c.id === chosen)
    ? chosen
    : (connections[0]?.id ?? "");
  const caps = value.connectionUsageCaps?.[id] ?? {};
  const update = (
    window: ConnectionUsageWindow,
    key: "tokens" | "apiCostUsd",
    raw: string,
  ) => {
    if (!id) return;
    const next: ConnectionUsageCaps = {
      ...caps,
      [window]: {
        ...caps[window],
        [key]: raw === "" ? undefined : key === "tokens" ? Number(raw) : raw,
      },
    };
    const clean = Object.fromEntries(
      (Object.keys(labels) as ConnectionUsageWindow[])
        .filter(
          (window) =>
            next[window] &&
            (next[window]!.tokens !== undefined ||
              next[window]!.apiCostUsd !== undefined),
        )
        .map((window) => [window, next[window]]),
    ) as ConnectionUsageCaps;
    if (next.onUnknownUsage) clean.onUnknownUsage = next.onUnknownUsage;
    const all = { ...value.connectionUsageCaps };
    if (Object.keys(clean).length) all[id] = clean;
    else delete all[id];
    onChange({ ...value, connectionUsageCaps: all });
  };
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="text-sm font-medium">
        {t("connectionUsageCaps")}
      </legend>
      <p className="text-xs text-muted-foreground">{t("connectionCapsHelp")}</p>
      {accounts.error && (
        <p role="alert" className="text-sm text-destructive">
          {t("capAccountsError")}
        </p>
      )}
      {!accounts.isPending && !accounts.error && !connections.length && (
        <p className="text-sm text-muted-foreground">{t("capNoConnections")}</p>
      )}
      {connections.length > 0 && (
        <>
          <label className="block space-y-1 text-sm">
            {t("capConnection")}
            <NativeSelect
              value={id}
              onChange={(e) => setChosen(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={caps.onUnknownUsage === "hold"}
              onChange={(event) =>
                onChange({
                  ...value,
                  connectionUsageCaps: {
                    ...value.connectionUsageCaps,
                    [id]: {
                      ...caps,
                      onUnknownUsage: event.target.checked ? "hold" : "report",
                    },
                  },
                })
              }
            />
            {t("capHoldUnknown")}
          </label>
          {(Object.keys(labels) as ConnectionUsageWindow[]).map((window) => {
            const status = usage.data?.connections
              .find((c) => c.connectionId === id)
              ?.windows.find((w) => w.window === window);
            return (
              <fieldset
                key={`${id}:${window}`}
                className="space-y-2 rounded-md border p-3"
              >
                <legend className="text-sm font-medium">
                  {t(labels[window])}
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-1 text-sm">
                    {t("capTokens")}
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      placeholder={t("capUnlimited")}
                      value={caps[window]?.tokens ?? ""}
                      onChange={(e) => update(window, "tokens", e.target.value)}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    {t("capApiCost")}
                    <Input
                      type="number"
                      min="0.000001"
                      step="any"
                      placeholder={t("capUnlimited")}
                      value={caps[window]?.apiCostUsd ?? ""}
                      onChange={(e) =>
                        update(window, "apiCostUsd", e.target.value)
                      }
                    />
                  </label>
                </div>
                {!connectionUsageWindowSchema.safeParse(caps[window] ?? {})
                  .success && (
                  <p role="alert" className="text-xs text-destructive">
                    {t("capInvalid")}
                  </p>
                )}
                {status && (
                  <p className="text-xs text-muted-foreground">
                    {t("capUsage", {
                      tokens:
                        status.tokens ??
                        t("capAtLeast", { value: status.knownTokens }),
                      cost:
                        status.apiCostUsd ??
                        t("capAtLeast", { value: status.knownApiCostUsd }),
                    })}{" "}
                    {status.blocked
                      ? t("capWaiting", {
                          at: status.retryAt
                            ? new Date(status.retryAt).toLocaleString()
                            : t("capUnknown"),
                        })
                      : (status.tokenCap !== undefined &&
                            status.tokens === null) ||
                          (status.apiCostCapUsd !== undefined &&
                            status.apiCostUsd === null)
                        ? t("capUncertain")
                        : t("capAvailable")}
                  </p>
                )}
              </fieldset>
            );
          })}
          {usage.error && (
            <p role="alert" className="text-sm text-destructive">
              {t("capUsageError")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("capInFlightHelp")}
          </p>
          <p className="text-xs text-muted-foreground">{t("capUnknownHelp")}</p>
        </>
      )}
    </fieldset>
  );
}
