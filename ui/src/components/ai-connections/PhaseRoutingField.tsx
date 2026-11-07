import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { PHASE_ROUTING_ADAPTERS, EXECUTION_RESPONSIBILITIES, type ExecutionPhase, type PhaseRouteProfile, type PhaseRouting, type AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { agentsApi } from "@/api/agents";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { AiConnectionField, aiProviderForAdapter } from "./AiConnectionField";
import { ResponsibilityField, CompanyResponsibilityFields } from "./ResponsibilityField";
import { phaseRoutingApi } from "@/api/phase-routing";

const harnessNames = { claude_local: "Claude", codex_local: "Codex", opencode_local: "OpenCode / GLM" };
function profileFor(adapterType: PhaseRouteProfile["adapterType"], id: string): PhaseRouteProfile {
  return { id, adapterType,
    model: { claude_local: DEFAULT_CLAUDE_LOCAL_MODEL, codex_local: DEFAULT_CODEX_LOCAL_MODEL, opencode_local: `openrouter/${DEFAULT_OPENCODE_LOCAL_MODEL}` }[adapterType],
    binding: { mode: "responsible_user", provider: aiProviderForAdapter(adapterType)!, method: adapterType === "opencode_local" ? "api_key" : "subscription" },
  };
}

export function recommendedPhaseRouting(): PhaseRouting {
  return { enabled: true, planning: [profileFor("claude_local", "claude"), profileFor("codex_local", "codex")],
    implementation: [profileFor("codex_local", "codex")], review: [profileFor("claude_local", "claude-review")], roleResponsibilities: { cto: "planning" }, unknownResetCooldownSeconds: 3600 };
}

function ProfileEditor({ profile, companyId, agentId, agentName, environmentId, onChange }: {
  profile: PhaseRouteProfile; companyId: string; agentId: string; agentName: string; environmentId?: string;
  onChange: (profile: PhaseRouteProfile) => void;
}) {
  const { t } = useTranslation("phaseRouting");
  const listId = useId();
  const models = useQuery({ queryKey: ["phase-route-models", companyId, profile.adapterType, profile.binding.provider, environmentId],
    queryFn: () => agentsApi.adapterModels(companyId, profile.adapterType, { provider: profile.binding.provider, environmentId }) });
  return <div className="space-y-3">
    <label className="block space-y-1 text-sm">{t("harness")}
      <NativeSelect value={profile.adapterType} onChange={event => onChange(profileFor(event.target.value as PhaseRouteProfile["adapterType"], profile.id))}>
        {PHASE_ROUTING_ADAPTERS.map(adapter => <option key={adapter} value={adapter}>{harnessNames[adapter]}</option>)}
      </NativeSelect>
    </label>
    <label className="block space-y-1 text-sm">{t("model")}
      <Input value={profile.model} list={listId} onChange={event => onChange({ ...profile, model: event.target.value })} />
      <datalist id={listId}>{models.data?.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
    </label>
    <label className="block space-y-1 text-sm">{t("effort")}
      <NativeSelect value={profile.effort ?? ""} onChange={event => onChange({ ...profile, effort: event.target.value ? event.target.value as PhaseRouteProfile["effort"] : undefined })}>
        <option value="">{t("modelDefault")}</option>
        {["low", "medium", "high", "xhigh"].map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </NativeSelect>
    </label>
    {models.error && <p role="alert" className="text-xs text-destructive">{t("modelLoadError")}</p>}
    <AiConnectionField companyId={companyId} agentId={agentId || undefined} agentName={agentName} adapterType={profile.adapterType} model={profile.model}
      environmentId={environmentId} value={profile.binding} allowPools={false}
      onChange={binding => { if (binding.mode !== "router") onChange({ ...profile, binding }); }} />
  </div>;
}

export function PhaseRoutingField({ companyId, agentId, agentName, adapterType, model, binding, environmentId, value, onChange }: {
  companyId: string; agentId: string; agentName: string; adapterType: string; model: string;
  binding?: AiRuntimeConnectionBinding; environmentId?: string; value?: PhaseRouting;
  onChange: (value: PhaseRouting) => void;
}) {
  const { t } = useTranslation("phaseRouting");
  if (!(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(adapterType)) return null;
  const enabled = value?.enabled ?? false;
  const update = (phase: ExecutionPhase, profiles: PhaseRouteProfile[]) => {
    if (value) onChange({ ...value, [phase]: profiles });
  };
  return <div className="space-y-4 rounded-md border p-4">
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" checked={enabled} disabled={!binding || binding.mode === "router"}
        onChange={event => {
          if (value) return onChange({ ...value, enabled: event.target.checked });
          if (!binding || binding.mode === "router") return;
          const defaults = recommendedPhaseRouting();
          const applyCurrent = (profile: PhaseRouteProfile) => profile.adapterType === adapterType ? { ...profile, model, binding } : profile;
          onChange({ ...defaults, planning: defaults.planning.map(applyCurrent), implementation: defaults.implementation.map(applyCurrent), review: defaults.review?.map(applyCurrent) });
        }} />{t("enabled")}
    </label>
    <p className="text-xs text-muted-foreground">{t("description")}</p>
    {!binding && <p className="text-xs text-muted-foreground">{t("connectFirst")}</p>}
    {enabled && value && !agentId && <CompanyResponsibilityFields value={value} onChange={onChange} />}
    {enabled && value && EXECUTION_RESPONSIBILITIES.map(phase => <fieldset key={phase} className="space-y-3">
      <legend className="text-sm font-medium">{t(phase)}</legend>
      {(value[phase] ?? []).map((profile, index) => <div key={profile.id} className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{index === 0 ? t("primary") : t("fallback", { number: index })}</span>
          <div className="flex items-center gap-2">
            {index > 0 && <Button variant="ghost" size="sm" aria-label={t("moveUp")} onClick={() => {
              const profiles = [...(value[phase] ?? [])];
              [profiles[index - 1], profiles[index]] = [profiles[index], profiles[index - 1]];
              update(phase, profiles);
            }}>{t("moveUp")}</Button>}
          {(value[phase]?.length ?? 0) > 1 && <Button variant="ghost" size="sm" onClick={() => update(phase, (value[phase] ?? []).filter((_, i) => i !== index))}>{t("remove")}</Button>}
          </div>
        </div>
        <ProfileEditor profile={profile} companyId={companyId} agentId={agentId} agentName={agentName} environmentId={environmentId}
          onChange={next => update(phase, (value[phase] ?? []).map((entry, i) => i === index ? next : entry))} />
      </div>)}
      <Button variant="outline" size="sm" onClick={() => update(phase, [...(value[phase] ?? []), profileFor("codex_local", crypto.randomUUID())])}>{t("addFallback")}</Button>
    </fieldset>)}
    {enabled && value && <label className="block space-y-1 text-sm">{t("unknownCooldown")}
      <Input type="number" min={60} max={86400} value={value.unknownResetCooldownSeconds} onChange={event => onChange({ ...value, unknownResetCooldownSeconds: Number(event.target.value) })} />
    </label>}
  </div>;
}

export function AgentPhaseRoutingField(props: Parameters<typeof PhaseRoutingField>[0] & { onInherit: () => void; responsibility?: unknown; onResponsibilityChange?: (value: ExecutionPhase | undefined) => void }) {
  const { t } = useTranslation("phaseRouting");
  const defaults = useQuery({ queryKey: ["phase-routing", props.companyId], queryFn: () => phaseRoutingApi.get(props.companyId) });
  if (!(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(props.adapterType)) return null;
  return <div className="space-y-3">
    {props.onResponsibilityChange && <ResponsibilityField value={props.responsibility} onChange={props.onResponsibilityChange} />}
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={props.value === undefined} onChange={event => {
        if (event.target.checked) props.onInherit();
        else props.onChange(defaults.data?.policy ?? { ...recommendedPhaseRouting(), enabled: false });
      }} />{t("inherit")}
    </label>
    {defaults.error && <p role="alert" className="text-xs text-destructive">{t("defaultsLoadError")}</p>}
    {props.value === undefined
      ? <p className="text-xs text-muted-foreground">{defaults.data?.policy?.enabled
          ? t("inheritedSummary", { planning: defaults.data.policy.planning.map(profile => profile.model).join(" → "), implementation: defaults.data.policy.implementation.map(profile => profile.model).join(" → "), review: defaults.data.policy.review?.map(profile => profile.model).join(" → ") ?? t("reviewUnconfigured") })
          : t("companyDisabled")}</p>
      : <PhaseRoutingField {...props} value={{ ...defaults.data?.policy, ...props.value }} />}
  </div>;
}
