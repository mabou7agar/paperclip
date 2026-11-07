import { AGENT_ROLES, AGENT_ROLE_LABELS, EXECUTION_RESPONSIBILITIES, type ExecutionPhase, type PhaseRouting } from "@paperclipai/shared";
import { NativeSelect } from "@/components/ui/select";
import { useTranslation } from "@/i18n";

export function ResponsibilityField({ value, onChange, label }: {
  value?: unknown; onChange: (value: ExecutionPhase | undefined) => void; label?: string;
}) {
  const { t } = useTranslation("phaseRouting");
  return <label className="block space-y-1 text-sm">{label ?? t("responsibility")}
    <NativeSelect value={typeof value === "string" ? value : ""}
      onChange={event => onChange(event.target.value ? event.target.value as ExecutionPhase : undefined)}>
      <option value="">{t("inheritResponsibility")}</option>
      {EXECUTION_RESPONSIBILITIES.map(value => <option key={value} value={value}>{t(value)}</option>)}
    </NativeSelect>
  </label>;
}

export function CompanyResponsibilityFields({ value, onChange }: {
  value: PhaseRouting; onChange: (value: PhaseRouting) => void;
}) {
  const { t } = useTranslation("phaseRouting");
  return <div className="space-y-3">
    <ResponsibilityField label={t("defaultResponsibility")} value={value.defaultResponsibility ?? "implementation"}
      onChange={next => onChange({ ...value, defaultResponsibility: next ?? "implementation" })} />
    <details className="space-y-3">
      <summary className="text-sm">{t("roleResponsibilities")}</summary>
      {AGENT_ROLES.map(role => <ResponsibilityField key={role} label={AGENT_ROLE_LABELS[role]} value={value.roleResponsibilities?.[role]}
        onChange={next => {
          const roles = { ...value.roleResponsibilities };
          if (next) roles[role] = next; else delete roles[role];
          onChange({ ...value, roleResponsibilities: roles });
        }} />)}
    </details>
  </div>;
}
