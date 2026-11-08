import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { phaseRoutingSchema, type PhaseRouting } from "@paperclipai/shared";
import { phaseRoutingApi } from "@/api/phase-routing";
import { useTranslation } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  PhaseRoutingField,
  recommendedPhaseRouting,
} from "./PhaseRoutingField";

export function CompanyPhaseRoutingSettings({
  companyId,
}: {
  companyId: string;
}) {
  const { t } = useTranslation("phaseRouting");
  const client = useQueryClient();
  const [draft, setDraft] = useState<PhaseRouting | null>(null);
  const [template] = useState(() => ({
    ...recommendedPhaseRouting(),
    enabled: false,
  }));
  const queryKey = ["phase-routing", companyId];
  const defaults = useQuery({
    queryKey,
    queryFn: () => phaseRoutingApi.get(companyId),
  });
  const policy = draft ?? defaults.data?.policy ?? template;
  const save = useMutation({
    mutationFn: () => phaseRoutingApi.save(companyId, policy),
    onSuccess: (result) => {
      client.setQueryData(queryKey, result);
      setDraft(null);
    },
  });
  return (
    <section className="max-w-2xl space-y-4" aria-label={t("companyTitle")}>
      <h2 className="text-sm font-semibold">{t("companyTitle")}</h2>
      {defaults.isPending ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : defaults.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("defaultsLoadError")}
        </p>
      ) : (
        <>
          <PhaseRoutingField
            companyId={companyId}
            agentId=""
            agentName={t("companyTitle")}
            adapterType="claude_local"
            model={template.planning[0].model}
            binding={template.planning[0].binding}
            value={policy}
            onChange={setDraft}
          />
          <fieldset className="space-y-2 rounded-md border p-4">
            <legend className="text-sm font-medium">
              {t("apiQuotaChecks")}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(policy.apiQuotaRecheckSeconds ?? 0) > 0}
                onChange={(event) =>
                  setDraft({
                    ...policy,
                    apiQuotaRecheckSeconds: event.target.checked ? 1800 : 0,
                  })
                }
              />
              {t("apiQuotaEnabled")}
            </label>
            {(policy.apiQuotaRecheckSeconds ?? 0) > 0 && (
              <label className="block space-y-1 text-sm">
                {t("apiQuotaInterval")}
                <Input
                  type="number"
                  min={300}
                  max={86400}
                  step={60}
                  value={policy.apiQuotaRecheckSeconds}
                  onChange={(event) =>
                    setDraft({
                      ...policy,
                      apiQuotaRecheckSeconds: Number(event.target.value),
                    })
                  }
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">{t("apiQuotaHelp")}</p>
          </fieldset>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => setDraft(null)}
              disabled={!draft || save.isPending}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={
                !draft ||
                save.isPending ||
                !phaseRoutingSchema.safeParse(policy).success
              }
            >
              {save.isPending ? t("saving") : t("saveDefaults")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
