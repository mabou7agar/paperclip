import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  usageHealthPolicySchema,
  type UsageHealthPolicy,
  type UsageHealthReport,
  type UsageHealthThresholds,
} from "@paperclipai/shared";
import { usageHealthApi } from "@/api/usage-health";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const fields = [
  "inputTokensPerRun",
  "outputTokensPerRun",
  "runsPerTaskHour",
  "cacheWriteShare",
  "minCacheWriteTokens",
] as const;
export function UsageHealthSettings({
  companyId,
  report,
}: {
  companyId: string;
  report: UsageHealthReport;
}) {
  const { t } = useTranslation("usageHealth"),
    client = useQueryClient();
  const [draft, setDraft] = useState<UsageHealthPolicy | null>(null),
    [scope, setScope] = useState("");
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const value = draft ?? report.policy;
  const thresholds = scope
    ? { ...value.thresholds, ...value.agentOverrides[scope] }
    : value.thresholds;
  const save = useMutation({
    mutationFn: () =>
      usageHealthApi.save(companyId, usageHealthPolicySchema.parse(value)),
    onSuccess: () => {
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["usage-health", companyId] });
    },
  });
  const edit = (key: keyof UsageHealthThresholds, n: number) =>
    setDraft(
      scope
        ? {
            ...value,
            agentOverrides: {
              ...value.agentOverrides,
              [scope]: { ...value.agentOverrides[scope], [key]: n },
            },
          }
        : { ...value, thresholds: { ...value.thresholds, [key]: n } },
    );
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {t("settings")}
      </summary>
      <div className="mt-4 space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => setDraft({ ...value, enabled: e.target.checked })}
          />
          {t("enabled")}
        </label>
        <Label className="flex flex-col gap-2">
          {t("scope")}
          <select
            className="rounded-md border bg-background p-2 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">{t("company")}</option>
            {(
              agents.data?.map((a) => ({ id: a.id, label: a.name })) ??
              report.byAgent.filter((a) => /^[a-f0-9-]{36}$/i.test(a.id))
            ).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Label>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((key) => (
            <Label key={key} className="flex flex-col gap-2">
              {t(key)}
              <Input
                type="number"
                min={key === "cacheWriteShare" ? 5 : 1}
                max={key === "cacheWriteShare" ? 100 : undefined}
                step={1}
                value={
                  key === "cacheWriteShare"
                    ? Math.round(thresholds[key] * 100)
                    : thresholds[key]
                }
                onChange={(e) =>
                  edit(
                    key,
                    Number(e.target.value) /
                      (key === "cacheWriteShare" ? 100 : 1),
                  )
                }
              />
            </Label>
          ))}
        </div>
        {scope && value.agentOverrides[scope] && (
          <Button
            variant="outline"
            onClick={() => {
              const overrides = { ...value.agentOverrides };
              delete overrides[scope];
              setDraft({ ...value, agentOverrides: overrides });
            }}
          >
            {t("inherit")}
          </Button>
        )}
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {t("saveError")}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            disabled={!draft || save.isPending}
            onClick={() => setDraft(null)}
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!draft || save.isPending}
            onClick={() => save.mutate()}
          >
            {t(save.isPending ? "saving" : "save")}
          </Button>
        </div>
      </div>
    </details>
  );
}
