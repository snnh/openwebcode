import type { ReactElement } from "react";
import type { ModelProfile, PermissionMode } from "../../lib/contracts";
import type { SessionDefaults } from "../../lib/prefs";
import { useI18n } from "../../i18n";

const PERMISSION_OPTIONS: Array<{ value: PermissionMode | ""; zh: string; en: string }> = [
  { value: "", zh: "不预设", en: "Not set" },
  { value: "ask", zh: "每次确认", en: "Ask every time" },
  { value: "acceptEdits", zh: "接受编辑", en: "Accept edits" },
  { value: "review", zh: "模型审核", en: "Model review" },
  { value: "yolo", zh: "YOLO", en: "YOLO" },
];

export function DefaultsSection({ defaults, setDefaults, providers, models }: {
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const { t } = useI18n();
  const availableModels = models.filter((item) => providers.includes(item.provider));
  const selected = defaults.provider && defaults.model ? JSON.stringify([defaults.provider, defaults.model]) : "";
  return (
    <div className="settings-grid">
      <label className="settings-field">
        <span>{t("默认模型", "Default model")}</span>
        <select
          className="input"
          value={selected}
          onChange={(event) => {
            if (!event.target.value) setDefaults({ ...defaults, provider: undefined, model: undefined });
            else {
              const [provider, model] = JSON.parse(event.target.value) as [string, string];
              setDefaults({ ...defaults, provider, model });
            }
          }}
        >
          <option value="">{t("不预设", "Not set")}</option>
          {availableModels.map((item) => {
            const value = JSON.stringify([item.provider, item.id]);
            return <option key={value} value={value}>{t(`${item.id}【${item.provider}】`, `${item.id} (${item.provider})`)}</option>;
          })}
        </select>
      </label>
      <label className="settings-field">
        <span>{t("默认权限模式", "Default permission mode")}</span>
        <select
          className="input"
          value={defaults.permissionMode ?? ""}
          onChange={(event) => setDefaults({ ...defaults, permissionMode: (event.target.value || undefined) as PermissionMode | undefined })}
        >
          {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.zh, option.en)}</option>)}
        </select>
      </label>
    </div>
  );
}
