import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SettingsField, SettingValue } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import {
  formatSettingValue,
  sameValue,
  MAX_SYNC_INTERVAL_MINUTES,
  MAX_UPDATE_CHECK_INTERVAL_HOURS,
  SETTINGS_FIELD_EN,
  SETTINGS_GROUP_EN,
  ZERO_ALLOWED_NUMBER_KEYS,
} from "./shared";

/** 服务设置字段表单：按分组过滤渲染，draft/校验/保存逻辑在各页签间共享。 */
export function ServerSettingsFields({ showGroup, note, onDirtyChange }: {
  showGroup(groupId: string): boolean;
  /** 分组列表前的说明文案 [zh, en]；不传则不渲染 */
  note?: [string, string];
  onDirtyChange?(dirty: boolean): void;
}): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [draft, setDraft] = useState<Record<string, string | boolean | null>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const dirty = Object.keys(draft).length > 0;
  // 向上汇报 dirty，供对话框关闭前确认
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  if (settings.isPending) return <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="muted-empty panel-empty">{t("无法加载服务设置。", "Could not load server settings.")}</p>;

  const fields = new Map(settings.data.groups.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));
  const fieldLabel = (field: SettingsField): string => language === "en" ? (SETTINGS_FIELD_EN[field.key]?.label ?? field.label) : field.label;
  const fieldDescription = (field: SettingsField): string | undefined => language === "en" ? (SETTINGS_FIELD_EN[field.key]?.description ?? field.description) : field.description;

  const setField = (key: string, value: string | boolean | null): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(undefined);
  };
  const resetField = (key: string): void => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = (): void => {
    const overrides: Record<string, SettingValue | null> = {};
    for (const [key, value] of Object.entries(draft)) {
      const field = fields.get(key);
      if (!field) continue;
      if (value === null) {
        overrides[key] = null;
        continue;
      }
      if (field.type === "secret" && value === "") continue;
      if (field.type === "number") {
        const parsed = Number(value);
        const allowsZero = ZERO_ALLOWED_NUMBER_KEYS.has(field.key);
        if (!Number.isSafeInteger(parsed) || parsed < (allowsZero ? 0 : 1)) {
          setError(allowsZero
            ? t(`${field.label} 必须是大于或等于 0 的整数`, `${fieldLabel(field)} must be a non-negative integer`)
            : t(`${field.label} 必须是正整数`, `${fieldLabel(field)} must be a positive integer`));
          return;
        }
        if (field.key === "syncIntervalMinutes" && parsed > MAX_SYNC_INTERVAL_MINUTES) {
          setError(t(`${field.label} 不能超过 ${MAX_SYNC_INTERVAL_MINUTES} 分钟`, `${fieldLabel(field)} cannot exceed ${MAX_SYNC_INTERVAL_MINUTES} minutes`));
          return;
        }
        if (field.key === "updateCheckIntervalHours" && parsed > MAX_UPDATE_CHECK_INTERVAL_HOURS) {
          setError(t(`${field.label} 不能超过 ${MAX_UPDATE_CHECK_INTERVAL_HOURS} 小时`, `${fieldLabel(field)} cannot exceed ${MAX_UPDATE_CHECK_INTERVAL_HOURS} hours`));
          return;
        }
        overrides[key] = parsed;
      } else if (field.type === "boolean") {
        overrides[key] = value === true;
      } else if (field.type === "pathList") {
        const paths = String(value).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
        if (paths.length > 16) {
          setError(t(`${field.label} 最多允许 16 个目录`, `${fieldLabel(field)} accepts at most 16 directories`));
          return;
        }
        overrides[key] = paths;
      } else if (value === "") {
        if (field.nullable) overrides[key] = null;
        else {
          setError(t(`${field.label} 不能为空`, `${fieldLabel(field)} cannot be empty`));
          return;
        }
      } else {
        overrides[key] = value;
      }
    }
    setSaving(true);
    setError(undefined);
    api.saveSettings(overrides)
      .then((view) => {
        queryClient.setQueryData(["settings"], view);
        setDraft({});
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : t("保存失败", "Failed to save")))
      .finally(() => setSaving(false));
  };

  const renderInput = (field: SettingsField): ReactElement => {
    const pending = draft[field.key];
    const resetting = pending === null;
    const disabled = !field.editable || resetting;
    if (field.type === "boolean") {
      const checked = typeof pending === "boolean" ? pending : field.value === true;
      return (
        <label className="theme-option">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => setField(field.key, event.target.checked)}
          />
          {checked ? t("开启", "On") : t("关闭", "Off")}
        </label>
      );
    }
    if (field.type === "select") {
      const value = typeof pending === "string" ? pending : String(field.value ?? "");
      return (
        <select className="input" value={resetting ? "" : value} disabled={disabled} onChange={(event) => setField(field.key, event.target.value || (field.nullable ? null : ""))} aria-label={fieldLabel(field)}>
          {field.nullable && <option value="">{t("不启用", "Disabled")}</option>}
          {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    if (field.type === "secret") {
      const value = typeof pending === "string" ? pending : "";
      return (
        <input
          type="password"
          value={resetting ? "" : value}
          placeholder={resetting ? t("保存后清除", "Clear on save") : field.hasValue ? t(`当前：${field.masked ?? "已设置"}`, `Current: ${field.masked ?? "set"}`) : t("未设置", "Not set")}
          disabled={disabled}
          onChange={(event) => setField(field.key, event.target.value)}
          aria-label={fieldLabel(field)}
          autoComplete="off"
        />
      );
    }
    if (field.type === "pathList") {
      const value = typeof pending === "string" ? pending : Array.isArray(field.value) ? field.value.join("\n") : "";
      return (
        <textarea
          className="input"
          rows={Math.max(2, Math.min(6, value.split("\n").length))}
          value={resetting ? "" : value}
          placeholder={resetting ? t("保存后重置为空", "Reset to empty on save") : t("每行一个绝对目录", "One absolute directory per line")}
          disabled={disabled}
          onChange={(event) => setField(field.key, event.target.value)}
          aria-label={fieldLabel(field)}
          spellCheck={false}
        />
      );
    }
    const value = typeof pending === "string" ? pending : String(field.value ?? "");
    return (
      <input
        className="input"
        type={field.type === "number" ? "number" : "text"}
        {...(field.type === "number" ? {
          min: ZERO_ALLOWED_NUMBER_KEYS.has(field.key) ? 0 : 1,
          ...(field.key === "syncIntervalMinutes" ? { max: MAX_SYNC_INTERVAL_MINUTES } : field.key === "updateCheckIntervalHours" ? { max: MAX_UPDATE_CHECK_INTERVAL_HOURS } : {}),
          step: 1,
        } : {})}
        value={resetting ? "" : value}
        placeholder={resetting ? t("保存后重置为默认", "Reset to default on save") : field.nullable ? t("未设置", "Not set") : undefined}
        disabled={disabled}
        onChange={(event) => setField(field.key, event.target.value)}
        aria-label={fieldLabel(field)}
        spellCheck={false}
      />
    );
  };

  const renderField = (field: SettingsField): ReactElement => {
    const pending = draft[field.key];
    const resetting = pending === null;
    return (
      <div className="settings-field" key={field.key}>
        <div className="settings-field-head">
          <span>{fieldLabel(field)}</span>
          <span className="settings-badges">
            {field.source === "env" && <span className="pill small accent">{t("环境变量", "Environment")}</span>}
            {field.source === "file" && <span className="pill small ok">{t("已覆盖", "Overridden")}</span>}
            {field.restartRequired && <span className="pill small">{t("重启后生效", "Restart required")}</span>}
            {resetting && <span className="pill small danger">{t("将重置", "Will reset")}</span>}
            {!resetting && pending !== undefined && <span className="pill small danger">{t("未保存", "Unsaved")}</span>}
            {resetting && (
              <button className="btn small" onClick={() => resetField(field.key)}>{t("撤销", "Undo")}</button>
            )}
            {!resetting && field.editable && field.type === "secret" && field.hasValue && (
              <button className="btn small" onClick={() => setField(field.key, null)}>{t("清除", "Clear")}</button>
            )}
            {!resetting && field.editable && field.type !== "secret" && field.source === "file" && (
              <button className="btn small" onClick={() => setField(field.key, null)}>{t("重置", "Reset")}</button>
            )}
          </span>
        </div>
        {renderInput(field)}
        {fieldDescription(field) && <p className="settings-note">{fieldDescription(field)}</p>}
        {!resetting && field.source === "file" && field.installDefault !== undefined && !sameValue(field.value, field.installDefault) && (
          <p className="settings-note">{t(`安装默认值现为 ${formatSettingValue(field.installDefault)}，可点「重置」采纳`, `Install default is now ${formatSettingValue(field.installDefault)}; click "Reset" to adopt`)}</p>
        )}
        {!field.editable && <p className="settings-note">{t("由环境变量控制，界面内不可修改", "Controlled by an environment variable and cannot be changed here")}</p>}
      </div>
    );
  };

  return (
    <>
      {note && <p className="settings-note">{t(note[0], note[1])}</p>}
      {settings.data.groups.filter((group) => showGroup(group.id)).map((group) => (
        <div className="server-settings-group" key={group.id}>
          <h4>{language === "en" ? (SETTINGS_GROUP_EN[group.id] ?? group.label) : group.label}</h4>
          {group.fields.map(renderField)}
        </div>
      ))}
      {error && <p className="settings-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" disabled={!dirty || saving} onClick={() => { setDraft({}); setError(undefined); }}>{t("放弃更改", "Discard changes")}</button>
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? t("保存中…", "Saving…") : t("保存服务设置", "Save server settings")}</button>
      </div>
    </>
  );
}
