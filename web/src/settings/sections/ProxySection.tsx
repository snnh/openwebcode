import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { SettingsField, SettingValue } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import { SETTINGS_FIELD_EN } from "./shared";

/**
 * 「联网服务」页签的代理子区：模式（关闭/跟随环境变量/自定义）+ 自定义模式下的
 * HTTP/HTTPS 代理与例外列表。走现有 settings REST（PUT /api/settings），
 * 代理地址按 secret 字段处理：留空保留、可显式清除，界面仅见脱敏值。
 * draft 语义与 ServerSettingsFields 一致：string = 待保存值，null = 保存后清除。
 */
export function ProxySection(): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  if (settings.isPending) return <p className="muted-empty panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="settings-error">{t("无法加载服务设置。", "Could not load server settings.")}</p>;

  const fields = new Map(settings.data.groups.flatMap((group) => group.fields.map((field) => [field.key, field] as const)));
  const modeField = fields.get("proxyMode");
  const httpField = fields.get("proxyHttp");
  const httpsField = fields.get("proxyHttps");
  const noProxyField = fields.get("proxyNoProxy");
  // 旧版 server 无代理字段时不渲染本子区
  if (!modeField || !httpField || !httpsField || !noProxyField) return <></>;

  const fieldLabel = (field: SettingsField): string => language === "en" ? (SETTINGS_FIELD_EN[field.key]?.label ?? field.label) : field.label;
  const fieldDescription = (field: SettingsField): string | undefined => language === "en" ? (SETTINGS_FIELD_EN[field.key]?.description ?? field.description) : field.description;

  const mode = draft["proxyMode"] ?? String(modeField.value ?? "env");
  const dirty = Object.keys(draft).length > 0;

  const setField = (key: string, value: string | null): void => {
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

  /** 保存后该代理地址是否生效（考虑 draft 新值/清除与已保存值）。 */
  const proxyEffective = (key: "proxyHttp" | "proxyHttps", field: SettingsField): boolean => {
    const pending = draft[key];
    if (pending === null) return false;
    if (typeof pending === "string" && pending.trim() !== "") return true;
    return field.hasValue;
  };

  const save = (): void => {
    if (mode === "custom" && !proxyEffective("proxyHttp", httpField) && !proxyEffective("proxyHttps", httpsField)) {
      setError(t("自定义模式下请至少填写一个代理地址", "Custom mode requires at least one proxy address"));
      return;
    }
    const overrides: Record<string, SettingValue | null> = {};
    for (const [key, value] of Object.entries(draft)) {
      const field = fields.get(key);
      if (!field) continue;
      if (value === null) { overrides[key] = null; continue; }
      // secret 留空 = 保留当前值，不写入
      if (field.type === "secret" && value === "") continue;
      // 其余字段（例外列表）清空即重置为默认
      overrides[key] = value === "" ? null : value;
    }
    if (Object.keys(overrides).length === 0) { setDraft({}); return; }
    setSaving(true);
    setError(undefined);
    api.saveSettings(overrides)
      .then((view) => {
        queryClient.setQueryData(["settings"], view);
        setDraft({});
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("保存失败", "Failed to save")))
      .finally(() => setSaving(false));
  };

  const renderProxyInput = (key: "proxyHttp" | "proxyHttps", field: SettingsField): ReactElement => {
    const pending = draft[key];
    const clearing = pending === null;
    return (
      <div className="settings-field" key={key}>
        <div className="settings-field-head">
          <span>{fieldLabel(field)}</span>
          <span className="settings-badges">
            {field.source === "env" && <span className="pill small accent">{t("环境变量", "Environment")}</span>}
            {clearing && <span className="pill small danger">{t("将清除", "Will clear")}</span>}
            {!clearing && pending !== undefined && pending !== "" && <span className="pill small danger">{t("未保存", "Unsaved")}</span>}
            {clearing && <button className="btn small" onClick={() => resetField(key)}>{t("撤销", "Undo")}</button>}
            {!clearing && field.editable && field.hasValue && <button className="btn small" onClick={() => setField(key, null)}>{t("清除", "Clear")}</button>}
          </span>
        </div>
        <input
          className="input"
          type="password"
          value={clearing ? "" : (pending ?? "")}
          placeholder={clearing ? t("保存后清除", "Clear on save") : field.hasValue ? t(`当前：${field.masked ?? "已设置"}`, `Current: ${field.masked ?? "set"}`) : "http://127.0.0.1:7890"}
          disabled={!field.editable || clearing}
          onChange={(event) => setField(key, event.target.value)}
          aria-label={fieldLabel(field)}
          autoComplete="off"
          spellCheck={false}
        />
        {fieldDescription(field) && <p className="settings-note">{fieldDescription(field)}</p>}
        {!field.editable && <p className="settings-note">{t("由环境变量控制，界面内不可修改", "Controlled by an environment variable and cannot be changed here")}</p>}
      </div>
    );
  };

  const noProxyPending = draft["proxyNoProxy"];
  const noProxyResetting = noProxyPending === null;

  return (
    <div className="server-settings-group">
      <h4>{t("代理", "Proxy")}</h4>
      <p className="settings-note">{t("作用于模型 API、联网搜索/抓取、更新检测与在线更新。", "Applies to model APIs, web search/fetch, update checks, and online updates.")}</p>
      <div className="settings-field">
        <div className="settings-field-head">
          <span>{fieldLabel(modeField)}</span>
          <span className="settings-badges">
            {modeField.source === "env" && <span className="pill small accent">{t("环境变量", "Environment")}</span>}
            {draft["proxyMode"] !== undefined && <span className="pill small danger">{t("未保存", "Unsaved")}</span>}
          </span>
        </div>
        <select
          className="input"
          value={mode}
          disabled={!modeField.editable}
          onChange={(event) => setField("proxyMode", event.target.value)}
          aria-label={fieldLabel(modeField)}
        >
          <option value="off">{t("关闭", "Off")}</option>
          <option value="env">{t("跟随环境变量", "Follow environment variables")}</option>
          <option value="custom">{t("自定义", "Custom")}</option>
        </select>
        {fieldDescription(modeField) && <p className="settings-note">{fieldDescription(modeField)}</p>}
        {!modeField.editable && <p className="settings-note">{t("由环境变量控制，界面内不可修改", "Controlled by an environment variable and cannot be changed here")}</p>}
      </div>
      {mode === "custom" && (
        <>
          {renderProxyInput("proxyHttp", httpField)}
          {renderProxyInput("proxyHttps", httpsField)}
          <div className="settings-field">
            <div className="settings-field-head">
              <span>{fieldLabel(noProxyField)}</span>
              <span className="settings-badges">
                {noProxyField.source === "env" && <span className="pill small accent">{t("环境变量", "Environment")}</span>}
                {noProxyResetting && <span className="pill small danger">{t("将重置", "Will reset")}</span>}
                {!noProxyResetting && noProxyPending !== undefined && <span className="pill small danger">{t("未保存", "Unsaved")}</span>}
              </span>
            </div>
            <input
              className="input"
              type="text"
              value={noProxyResetting ? "" : (noProxyPending ?? String(noProxyField.value ?? ""))}
              placeholder={t("internal.example.com, .corp.local", "internal.example.com, .corp.local")}
              disabled={!noProxyField.editable}
              onChange={(event) => setField("proxyNoProxy", event.target.value)}
              aria-label={fieldLabel(noProxyField)}
              spellCheck={false}
            />
            {fieldDescription(noProxyField) && <p className="settings-note">{fieldDescription(noProxyField)}</p>}
          </div>
        </>
      )}
      {error && <p className="settings-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" disabled={!dirty || saving} onClick={() => { setDraft({}); setError(undefined); }}>{t("放弃更改", "Discard changes")}</button>
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? t("保存中…", "Saving…") : t("保存代理设置", "Save proxy settings")}</button>
      </div>
    </div>
  );
}
