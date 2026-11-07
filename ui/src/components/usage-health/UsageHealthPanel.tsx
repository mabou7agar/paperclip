import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UsageHealthFlag, UsageHealthGroup } from "@paperclipai/shared";
import { usageHealthApi } from "@/api/usage-health";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { formatTokens, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageHealthSettings } from "./UsageHealthSettings";

function useUsageHealth(companyId: string, from?: string, to?: string) {
  return useQuery({
    queryKey: ["usage-health", companyId, from ?? null, to ?? null],
    queryFn: () => usageHealthApi.report(companyId, from, to),
    enabled: !!companyId && companyId !== "__none__",
    refetchInterval: 60_000,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === companyId && query.queryKey[2] === (from ?? null)
        ? previous
        : undefined,
  });
}
export function UsageHealthNotice({
  companyId,
  from,
  to,
}: {
  companyId: string;
  from?: string;
  to?: string;
}) {
  const { t } = useTranslation("usageHealth"),
    query = useUsageHealth(companyId, from, to);
  if (!query.data || query.data.status === "within_thresholds") return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">
          {t("title")}: {t(query.data.status)}
        </p>
        <p className="text-xs text-muted-foreground">{t("reportOnly")}</p>
      </div>
      <Button variant="outline" asChild>
        <Link to="/activity/costs?tab=usage-health">{t("open")}</Link>
      </Button>
    </div>
  );
}
function Flags({ items }: { items: UsageHealthFlag[] }) {
  const { t } = useTranslation("usageHealth");
  return (
    <div className="space-y-3">
      {items.length ? (
        items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
          >
            <div>
              <p className="font-medium">{t(`rules.${item.rule}`)}</p>
              <p className="text-xs text-muted-foreground">
                {item.agentName ??
                  t(`kinds.${item.kind}`, { defaultValue: item.kind })}{" "}
                · {formatDateTime(item.occurredAt)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {t("observed")}:{" "}
                {item.rule === "cache_writes"
                  ? `${Math.round(item.observed * 100)}%`
                  : formatTokens(item.observed)}
                {item.threshold !== null
                  ? ` / ${item.rule === "cache_writes" ? `${Math.round(item.threshold * 100)}%` : formatTokens(item.threshold)}`
                  : ""}
              </span>
              {item.kind === "agent" && item.agentId ? (
                <Link
                  className="text-primary underline"
                  to={`/agents/${item.agentId}/runs/${item.runId}`}
                >
                  {item.identifier ?? item.runId.slice(0, 8)}
                </Link>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      )}
    </div>
  );
}
export function UsageHealthPanel({
  companyId,
  from,
  to,
}: {
  companyId: string;
  from?: string;
  to?: string;
}) {
  const { t } = useTranslation("usageHealth"),
    query = useUsageHealth(companyId, from, to);
  const [group, setGroup] = useState<"byAgent" | "byModel" | "byTask">(
    "byAgent",
  );
  if (query.isPending)
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  if (query.error || !query.data)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  const report = query.data,
    totals = report.totals;
  const columns = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "totalTokens",
  ] as const;
  const labels = {
    inputTokens: "input",
    cachedInputTokens: "cacheRead",
    cacheWriteTokens: "cacheWrite",
    outputTokens: "output",
    totalTokens: "total",
  } as const;
  const groups = report[group] as UsageHealthGroup[];
  return (
    <section className="space-y-4" aria-label={t("title")}>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t("title")}</CardTitle>
            <Badge variant="outline">{t(report.status)}</Badge>
          </div>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {columns.map((key) => (
              <div key={key}>
                <p className="text-xs text-muted-foreground">
                  {t(labels[key])}
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatTokens(totals[key])}
                </p>
              </div>
            ))}
            <div>
              <p className="text-xs text-muted-foreground">{t("runs")}</p>
              <p className="text-2xl font-semibold tabular-nums">
                {totals.runs.toLocaleString()}
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("coverage", {
              measured: totals.measuredRuns,
              pending: totals.pendingRuns,
              missing: totals.missingRuns,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("writeCoverage", { count: totals.cacheWriteMeasuredRuns })}{" "}
            {t("requestCoverage", { count: totals.requestIdsReported })}
          </p>
          <p className="text-xs text-muted-foreground">{t("limits")}</p>
        </CardContent>
      </Card>
      {report.canManage && (
        <UsageHealthSettings companyId={companyId} report={report} />
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {t(
              group === "byAgent"
                ? "agents"
                : group === "byModel"
                  ? "models"
                  : "tasks",
            )}
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {(["byAgent", "byModel", "byTask"] as const).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={group === key ? "secondary" : "outline"}
                aria-pressed={group === key}
                onClick={() => setGroup(key)}
              >
                {t(
                  key === "byAgent"
                    ? "agents"
                    : key === "byModel"
                      ? "models"
                      : "tasks",
                )}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="p-2">{t("name")}</th>
                <th className="p-2">{t("runs")}</th>
                {columns.map((key) => (
                  <th key={key} className="p-2 text-end">
                    {t(labels[key])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="p-2">
                    {group === "byTask" && row.id !== "unassigned" ? (
                      <Link
                        className="text-primary underline"
                        to={`/issues/${row.id}`}
                      >
                        {row.label}
                      </Link>
                    ) : row.id === "unassigned" ? (
                      t("unassigned")
                    ) : (
                      row.label
                    )}
                  </td>
                  <td className="p-2 tabular-nums">{row.runs}</td>
                  {columns.map((key) => (
                    <td key={key} className="p-2 text-end tabular-nums">
                      {formatTokens(row[key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            {t("flags")} ({report.flagCount})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Flags items={report.flags} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("alerts")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Flags items={report.alerts} />
        </CardContent>
      </Card>
    </section>
  );
}
