import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ExtensionInfo, ModelProfile, PermissionMode, PricingDocument, SettingsField, SettingValue } from "../lib/contracts";
import { formatCurrency } from "../lib/format";
import { Icon } from "./Icon";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";
import type { SendKey, SessionDefaults } from "../lib/prefs";
import type { ThemePreference, AccentPreference } from "../theme";
import { useI18n, type Language } from "../i18n";

const THEME_OPTIONS: Array<{ value: ThemePreference; zh: string; en: string }> = [
  { value: "light", zh: "浅色", en: "Light" },
  { value: "dark", zh: "深色", en: "Dark" },
  { value: "system", zh: "跟随系统", en: "System" },
];

const ACCENT_OPTIONS: Array<{ value: AccentPreference; zh: string; en: string; swatch: string }> = [
  { value: "teal", zh: "青", en: "Teal", swatch: "#0b7285" },
  { value: "violet", zh: "紫", en: "Violet", swatch: "#6c5ce7" },
  { value: "blue", zh: "蓝", en: "Blue", swatch: "#2563eb" },
  { value: "orange", zh: "橙", en: "Orange", swatch: "#e8590c" },
  { value: "rose", zh: "玫红", en: "Rose", swatch: "#e1235c" },
  { value: "green", zh: "绿", en: "Green", swatch: "#2f9e44" },
];

type SettingsTab = "appearance" | "general" | "defaults" | "server" | "models" | "skills" | "extensions" | "pricing" | "info";

const TAB_META: Array<{ id: SettingsTab; zh: string; en: string }> = [
  { id: "appearance", zh: "外观", en: "Appearance" },
  { id: "general", zh: "通用", en: "General" },
  { id: "defaults", zh: "会话默认", en: "Session defaults" },
  { id: "server", zh: "服务设置", en: "Server" },
  { id: "models", zh: "模型目录", en: "Models" },
  { id: "skills", zh: "技能", en: "Skills" },
  { id: "extensions", zh: "扩展", en: "Extensions" },
  { id: "pricing", zh: "模型定价", en: "Pricing" },
  { id: "info", zh: "服务信息", en: "Server info" },
];

const PERMISSION_OPTIONS: Array<{ value: PermissionMode | ""; zh: string; en: string }> = [
  { value: "", zh: "不预设", en: "Not set" },
  { value: "ask", zh: "每次确认", en: "Ask every time" },
  { value: "acceptEdits", zh: "接受编辑", en: "Accept edits" },
  { value: "yolo", zh: "YOLO", en: "YOLO" },
];

const SETTINGS_GROUP_EN: Record<string, string> = {
  models: "Model providers",
  provider2: "Context compaction",
  search: "Web search",
  general: "Language and currency",
  executor: "Executor",
  service: "Service",
  exchangeRate: "Exchange rate",
};

const SETTINGS_FIELD_EN: Record<string, { label: string; description?: string }> = {
  anthropicApiKey: { label: "Anthropic API Key" },
  anthropicBaseURL: { label: "Anthropic Base URL", description: "Leave empty to use the official endpoint" },
  anthropicPromptCaching: { label: "Anthropic prompt caching" },
  openaiBaseURL: { label: "OpenAI-compatible Base URL", description: "Enables the OpenAI-compatible provider when set" },
  openaiApiKey: { label: "OpenAI API Key" },
  catalogSyncUrl: { label: "Remote model catalog URL", description: "Leave empty to disable remote model catalog sync" },
  pricingSyncUrl: { label: "Remote pricing catalog URL", description: "Leave empty to disable remote pricing sync" },
  syncIntervalMinutes: { label: "Remote sync interval (minutes)", description: "0 means manual sync only; a value above 0 enables periodic sync (maximum 35,791 minutes)" },
  provider2BaseURL: { label: "provider2 Base URL", description: "OpenAI-compatible endpoint; enabled when both endpoint and model are set" },
  provider2ApiKey: { label: "provider2 API Key" },
  provider2Model: { label: "provider2 model", description: "For example, deepseek-chat or claude-haiku-4-5" },
  searchProvider: { label: "Search provider" },
  searchApiKey: { label: "Search API Key" },
  searchBaseURL: { label: "Search Base URL", description: "HTTP endpoint for the custom provider" },
  defaultLanguage: { label: "Default model language" },
  defaultCurrency: { label: "Default currency" },
  corePath: { label: "Executor path" },
  coreRequestTimeoutMs: { label: "Executor request timeout (ms)" },
  sandboxAllowPaths: { label: "Additional AppContainer directories", description: "One directory per line, up to 16; merged with the session working directory at execution time" },
  jobObjectMemoryMB: { label: "Job memory limit (MB)", description: "Job Object commit-memory limit; defaults to 4096" },
  jobObjectMaxProcesses: { label: "Job process limit", description: "Job Object active-process limit; defaults to 64" },
  gcMaxBytes: { label: "Storage limit (bytes)", description: "Global LRU limit for session artifacts; oldest data is removed first" },
  host: { label: "Listen address" },
  port: { label: "Listen port" },
  dataDir: { label: "Data directory" },
  exchangeRateUrl: { label: "Exchange-rate API URL" },
  exchangeRateTimeoutMs: { label: "Exchange-rate request timeout (ms)" },
  fixedUsdCnyRate: { label: "Fixed USD/CNY rate", description: "Skips online exchange-rate lookup when set" },
};

const MAX_SYNC_INTERVAL_MINUTES = 35_791;

const OFFICIAL_EXTENSION_EN: Record<string, { name: string; description: string }> = {
  "context-manager": { name: "Context Manager", description: "Rolling eviction, context compaction, writeback, and ledger views." },
  "attention-optimizer": { name: "Attention Optimizer", description: "Copies critical constraints and the current task into a context anchor to reduce lost-in-the-middle effects." },
  "content-lens": { name: "Content Lens", description: "Translates messages and explains selected text without adding content to the model context." },
  "pdf-to-image": { name: "PDF to Image", description: "Converts PDF pages into image attachments for models that support image input." },
};

interface PricingForm {
  provider: string;
  model: string;
  currency: "USD" | "CNY";
  effectiveFrom: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

function localDateValue(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyPricingForm(): PricingForm {
  return { provider: "", model: "", currency: "CNY", effectiveFrom: localDateValue(), input: "", output: "", cacheRead: "", cacheWrite: "" };
}

export function PricingSection(): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const pricing = useQuery({ queryKey: ["model-pricing"], queryFn: api.modelPricing });
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 添加条目表单
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<PricingForm>(emptyPricingForm);

  const startEdit = (): void => {
    if (!pricing.data) return;
    setJson(JSON.stringify(pricing.data, null, 2));
    setError(undefined);
    setEditing(true);
  };

  const save = async (document: PricingDocument): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api.saveModelPricing(document);
      setEditing(false);
      setAdding(false);
      void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("保存失败", "Failed to save"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveJson = (): void => {
    let document: PricingDocument;
    try {
      document = JSON.parse(json) as PricingDocument;
    } catch {
      setError(t("JSON 解析失败，请检查格式。", "Could not parse JSON. Check its syntax."));
      return;
    }
    void save(document);
  };

  const addEntry = (): void => {
    if (!pricing.data) return;
    const model = form.model.trim();
    const provider = form.provider.trim();
    if (!model || !provider) {
      setError(t("模型 id 与 provider 必填", "Model ID and provider are required"));
      return;
    }
    if (!form.effectiveFrom) {
      setError(t("请选择生效日期", "Select an effective date"));
      return;
    }
    // 价格字段：每百万 tokens 单价（元/美元），转 micro-units（×1000000）
    const toMicro = (value: string, label: string, optional = false): string => {
      const trimmed = value.trim();
      if (!trimmed) {
        if (optional) return "0";
        throw new Error(t(`${label}必填`, `${label} is required`));
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) throw new Error(t(`${label}「${value}」无效`, `Invalid ${label}: ${value}`));
      return String(Math.round(num * 1_000_000));
    };
    let parsed: { input: string; output: string; cacheRead: string; cacheWrite: string };
    try {
      parsed = {
        input: toMicro(form.input, t("输入单价", "input price")),
        output: toMicro(form.output, t("输出单价", "output price")),
        cacheRead: toMicro(form.cacheRead, t("缓存读单价", "cache-read price"), true),
        cacheWrite: toMicro(form.cacheWrite, t("缓存写单价", "cache-write price"), true),
      };
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : t("价格格式错误", "Invalid price format"));
      return;
    }
    const document: PricingDocument = {
      ...pricing.data,
      updatedAt: new Date().toISOString(),
      entries: [
        ...pricing.data.entries,
        {
          provider,
          model,
          currency: form.currency as "USD" | "CNY",
          effectiveFrom: form.effectiveFrom,
          input: parsed.input,
          output: parsed.output,
          cacheRead: parsed.cacheRead,
          cacheWrite: parsed.cacheWrite,
        },
      ],
    };
    void save(document).then((saved) => {
      if (saved) setForm(emptyPricingForm());
    });
  };

  const removeEntry = (index: number): void => {
    if (!pricing.data) return;
    const entry = pricing.data.entries[index];
    if (!entry) return;
    if (!window.confirm(t(`删除 ${entry.provider}/${entry.model} 的定价？`, `Delete pricing for ${entry.provider}/${entry.model}?`))) return;
    const document: PricingDocument = {
      ...pricing.data,
      updatedAt: new Date().toISOString(),
      entries: pricing.data.entries.filter((_, i) => i !== index),
    };
    void save(document);
  };

  const syncRemote = (): void => {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    api.syncModelPricing()
      .then((result) => {
        if (!result.ok) {
          setError(result.error || t("远程定价同步失败", "Remote pricing sync failed"));
          return;
        }
        const updatedAt = new Date(result.updatedAt).toLocaleString(locale);
        setNotice(t(`已同步 ${result.count} 条远程定价 · ${updatedAt}`, `Synced ${result.count} remote pricing entries · ${updatedAt}`));
        void queryClient.invalidateQueries({ queryKey: ["model-pricing"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      })
      .catch((syncError: unknown) => setError(syncError instanceof Error ? syncError.message : t("远程定价同步失败", "Remote pricing sync failed")))
      .finally(() => setSaving(false));
  };

  if (pricing.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (pricing.isError || !pricing.data) return <p className="panel-empty">{t("无法加载定价目录。", "Could not load the pricing catalog.")}</p>;

  const document = pricing.data;
  return (
    <>
      <div className="pricing-head">
        <span className="settings-note">{t(`${document.entries.length} 条定价 · 每百万 tokens 单价 · 更新于 ${new Date(document.updatedAt).toLocaleString(locale)}`, `${document.entries.length} entries · price per million tokens · updated ${new Date(document.updatedAt).toLocaleString(locale)}`)}</span>
        {!editing && !adding && <button className="btn small" disabled={saving} onClick={syncRemote}>{saving ? t("同步中…", "Syncing…") : t("立即同步", "Sync now")}</button>}
        {!editing && !adding && <button className="btn small" onClick={() => { setForm(emptyPricingForm()); setError(undefined); setAdding(true); }}>{t("添加条目", "Add entry")}</button>}
        {!editing && <button className="btn small" onClick={startEdit}>{t("编辑 JSON", "Edit JSON")}</button>}
      </div>
      {notice && <p className="settings-note">{notice}</p>}
      {adding && (
        <div className="pricing-add-form">
          <h4>{t("添加定价条目", "Add pricing entry")}</h4>
          <p className="settings-note">{t("价格为每百万 tokens 单价（元/美元），保存时自动转 micro-units。", "Enter prices per million tokens (CNY/USD). Values are converted to micro-units when saved.")}</p>
          <div className="catalog-form">
            <input value={form.provider} placeholder="provider" aria-label="provider" onChange={(e) => setForm((p) => ({ ...p, provider: e.target.value }))} spellCheck={false} />
            <input value={form.model} placeholder={t("模型 id", "Model ID")} aria-label={t("模型 id", "Model ID")} onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))} spellCheck={false} />
            <select value={form.currency} aria-label={t("币种", "Currency")} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value as PricingForm["currency"] }))}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
            <input type="date" value={form.effectiveFrom} aria-label={t("生效日期", "Effective date")} title={t("生效日期", "Effective date")} onChange={(e) => setForm((p) => ({ ...p, effectiveFrom: e.target.value }))} />
            <input type="number" min="0" step="any" value={form.input} placeholder={t("输入单价", "Input price")} aria-label={t("输入单价", "Input price")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, input: e.target.value }))} />
            <input type="number" min="0" step="any" value={form.output} placeholder={t("输出单价", "Output price")} aria-label={t("输出单价", "Output price")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, output: e.target.value }))} />
            <input type="number" min="0" step="any" value={form.cacheRead} placeholder={t("缓存读（可空）", "Cache read (optional)")} aria-label={t("缓存读", "Cache read")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheRead: e.target.value }))} />
            <input type="number" min="0" step="any" value={form.cacheWrite} placeholder={t("缓存写（可空）", "Cache write (optional)")} aria-label={t("缓存写", "Cache write")} inputMode="decimal" onChange={(e) => setForm((p) => ({ ...p, cacheWrite: e.target.value }))} />
          </div>
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={() => { setAdding(false); setError(undefined); }}>{t("取消", "Cancel")}</button>
            <button className="btn primary" disabled={saving} onClick={addEntry}>{saving ? t("保存中…", "Saving…") : t("添加", "Add")}</button>
          </div>
        </div>
      )}
      {editing ? (
        <>
          <textarea
            className="pricing-editor mono"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            aria-label={t("定价目录 JSON", "Pricing catalog JSON")}
            spellCheck={false}
          />
          {error && <p className="settings-error">{error}</p>}
          <div className="dialog-actions">
            <button className="btn" disabled={saving} onClick={() => setEditing(false)}>{t("取消", "Cancel")}</button>
            <button className="btn primary" disabled={saving} onClick={saveJson}>{saving ? t("保存中…", "Saving…") : t("保存定价", "Save pricing")}</button>
          </div>
        </>
      ) : (
        <>
          <table className="pricing-table">
            <thead>
              <tr><th>{t("模型", "Model")}</th><th>Provider</th><th>{t("币种", "Currency")}</th><th>{t("输入", "Input")}</th><th>{t("输出", "Output")}</th><th>{t("缓存读", "Cache read")}</th><th>{t("缓存写", "Cache write")}</th><th></th></tr>
            </thead>
            <tbody>
              {document.entries.map((entry, index) => (
                <tr key={`${entry.provider}/${entry.model}/${index}`}>
                  <td className="mono">{entry.model}</td>
                  <td>{entry.provider}</td>
                  <td>{entry.currency}</td>
                  <td className="mono">{entry.input ? formatCurrency(entry.input, entry.currency) : "—"}</td>
                  <td className="mono">{entry.output ? formatCurrency(entry.output, entry.currency) : "—"}</td>
                  <td className="mono">{entry.cacheRead ? formatCurrency(entry.cacheRead, entry.currency) : "—"}</td>
                  <td className="mono">{entry.cacheWrite ? formatCurrency(entry.cacheWrite, entry.currency) : "—"}</td>
                  <td><button className="badge badge-action" disabled={saving} onClick={() => removeEntry(index)}>{t("删除", "Delete")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <p className="settings-error">{error}</p>}
        </>
      )}
    </>
  );
}

function DefaultsSection({ defaults, setDefaults, providers, models }: {
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const { t } = useI18n();
  const provider = defaults.provider ?? "";
  const availableModels = models.filter((item) => item.provider === provider);
  return (
    <div className="settings-grid">
      <label>
        {t("默认 Provider", "Default provider")}
        <select
          value={provider}
          onChange={(event) => {
            const next = event.target.value || undefined;
            setDefaults({ ...defaults, provider: next, model: undefined });
          }}
        >
          <option value="">{t("不预设", "Not set")}</option>
          {providers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label>
        {t("默认模型", "Default model")}
        <select
          value={defaults.model ?? ""}
          disabled={!provider || availableModels.length === 0}
          onChange={(event) => setDefaults({ ...defaults, model: event.target.value || undefined })}
        >
          <option value="">{t("不预设", "Not set")}</option>
          {availableModels.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>)}
        </select>
      </label>
      <label>
        {t("默认权限模式", "Default permission mode")}
        <select
          value={defaults.permissionMode ?? ""}
          onChange={(event) => setDefaults({ ...defaults, permissionMode: (event.target.value || undefined) as PermissionMode | undefined })}
        >
          {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.zh, option.en)}</option>)}
        </select>
      </label>
    </div>
  );
}

function ServerInfoSection({ providers, models }: {
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const { t } = useI18n();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  return (
    <dl className="server-info">
      <dt>{t("API 状态", "API status")}</dt>
      <dd>{health.data?.status === "ok" ? t("在线", "Online") : health.isError ? t("不可达", "Unavailable") : t("检查中…", "Checking…")}</dd>
      <dt>Providers</dt>
      <dd>{providers.length > 0 ? providers.join("、") : "—"}</dd>
      <dt>{t("模型档案", "Model profiles")}</dt>
      <dd>{t(`${models.length} 个`, `${models.length}`)}</dd>
    </dl>
  );
}

function ServerSettingsSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [draft, setDraft] = useState<Record<string, string | boolean | null>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const dirty = Object.keys(draft).length > 0;
  // 向上汇报 dirty，供对话框关闭前确认
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  if (settings.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="panel-empty">{t("无法加载服务设置。", "Could not load server settings.")}</p>;

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
        const allowsZero = field.key === "syncIntervalMinutes";
        if (!Number.isSafeInteger(parsed) || parsed < (allowsZero ? 0 : 1)) {
          setError(allowsZero
            ? t(`${field.label} 必须是大于或等于 0 的整数`, `${fieldLabel(field)} must be a non-negative integer`)
            : t(`${field.label} 必须是正整数`, `${fieldLabel(field)} must be a positive integer`));
          return;
        }
        if (allowsZero && parsed > MAX_SYNC_INTERVAL_MINUTES) {
          setError(t(`${field.label} 不能超过 ${MAX_SYNC_INTERVAL_MINUTES} 分钟`, `${fieldLabel(field)} cannot exceed ${MAX_SYNC_INTERVAL_MINUTES} minutes`));
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
        <select value={value} disabled={disabled} onChange={(event) => setField(field.key, event.target.value)} aria-label={fieldLabel(field)}>
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
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
        type={field.type === "number" ? "number" : "text"}
        {...(field.type === "number" ? {
          min: field.key === "syncIntervalMinutes" ? 0 : 1,
          ...(field.key === "syncIntervalMinutes" ? { max: MAX_SYNC_INTERVAL_MINUTES } : {}),
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
            {field.source === "env" && <span className="badge badge-env">{t("环境变量", "Environment")}</span>}
            {field.source === "file" && <span className="badge badge-file">{t("已覆盖", "Overridden")}</span>}
            {field.restartRequired && <span className="badge badge-restart">{t("重启后生效", "Restart required")}</span>}
            {resetting && <span className="badge badge-dirty">{t("将重置", "Will reset")}</span>}
            {!resetting && pending !== undefined && <span className="badge badge-dirty">{t("未保存", "Unsaved")}</span>}
            {resetting && (
              <button className="badge badge-action" onClick={() => resetField(field.key)}>{t("撤销", "Undo")}</button>
            )}
            {!resetting && field.editable && field.type === "secret" && field.hasValue && (
              <button className="badge badge-action" onClick={() => setField(field.key, null)}>{t("清除", "Clear")}</button>
            )}
            {!resetting && field.editable && field.type !== "secret" && field.source === "file" && (
              <button className="badge badge-action" onClick={() => setField(field.key, null)}>{t("重置", "Reset")}</button>
            )}
          </span>
        </div>
        {renderInput(field)}
        {fieldDescription(field) && <p className="settings-note">{fieldDescription(field)}</p>}
        {!field.editable && <p className="settings-note">{t("由环境变量控制，界面内不可修改", "Controlled by an environment variable and cannot be changed here")}</p>}
      </div>
    );
  };

  return (
    <>
      <p className="settings-note">{t("服务端全部配置项。密钥仅脱敏显示；保存的密钥以明文存放在本机数据目录。", "All server settings. Secrets are masked here but stored as plain text in the local data directory.")}</p>
      {settings.data.groups.map((group) => (
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

const SOURCE_LABEL: Record<string, [string, string]> = { builtin: ["内置", "Built-in"], api: ["API", "API"], synced: ["远程同步", "Synced"], manual: ["手动", "Manual"] };
const THINKING_LABEL: Record<string, [string, string]> = { adaptive: ["自适应", "Adaptive"], enabled: ["开启", "Enabled"], disabled: ["关闭", "Disabled"] };
const THINKING_OPTIONS = ["adaptive", "enabled", "disabled"] as const;
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODALITY_OPTIONS = ["text", "image", "video"] as const;
const MODALITY_LABEL: Record<string, [string, string]> = { text: ["文本", "Text"], image: ["图片", "Image"], video: ["视频", "Video"] };

interface ModelEditForm {
  id: string;
  provider: string;
  contextWindow: string;
  maxOutput: string;
  thinking: string[];
  effort: string[];
  modalities: string[];
  imageOutput: boolean;
  tools: boolean;
}

export function ModelCatalogSection(): ReactElement {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const syncStatus = useQuery({ queryKey: ["model-sync-status"], queryFn: api.modelSyncStatus });
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: "", provider: "", contextWindow: "" });
  const [editing, setEditing] = useState<ModelEditForm | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["model-sync-status"] });
  };

  const refresh = (): void => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    api.refreshModels()
      .then((report) => {
        invalidate();
        const base = t(`新增 ${report.added} 个 · API 目录共 ${report.total} 个`, `${report.added} added · ${report.total} total from APIs`);
        if (report.errors.length > 0) setError(t(`${base}；部分失败：${report.errors.join("；")}`, `${base}; some failed: ${report.errors.join("; ")}`));
        else setNotice(base);
      })
      .catch((refreshError: unknown) => setError(refreshError instanceof Error ? refreshError.message : t("刷新失败", "Refresh failed")))
      .finally(() => setBusy(false));
  };

  const syncRemote = (): void => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    api.syncModels()
      .then((result) => {
        if (!result.ok) {
          setError(result.error || t("远程模型目录同步失败", "Remote model catalog sync failed"));
          return;
        }
        invalidate();
        const updatedAt = new Date(result.updatedAt).toLocaleString(locale);
        setNotice(t(`已同步 ${result.count} 个远程模型 · ${updatedAt}`, `Synced ${result.count} remote models · ${updatedAt}`));
      })
      .catch((syncError: unknown) => setError(syncError instanceof Error ? syncError.message : t("远程模型目录同步失败", "Remote model catalog sync failed")))
      .finally(() => setBusy(false));
  };

  const addManual = (): void => {
    const id = form.id.trim();
    if (!id) {
      setError(t("模型 id 不能为空", "Model ID cannot be empty"));
      return;
    }
    const contextWindow = form.contextWindow.trim() ? Number(form.contextWindow) : undefined;
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) {
      setError(t("上下文窗口必须是正整数", "Context window must be a positive integer"));
      return;
    }
    setBusy(true);
    setError(undefined);
    api.saveModel(id, { ...(form.provider.trim() ? { provider: form.provider.trim() } : {}), ...(contextWindow ? { contextWindow } : {}) })
      .then(() => {
        setForm({ id: "", provider: "", contextWindow: "" });
        setNotice(t(`已保存手动模型 ${id}`, `Saved manual model ${id}`));
        invalidate();
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : t("保存失败", "Failed to save")))
      .finally(() => setBusy(false));
  };

  const removeManual = (id: string): void => {
    if (!window.confirm(t(`删除手动模型「${id}」？`, `Delete manual model “${id}”?`))) return;
    setBusy(true);
    setError(undefined);
    api.deleteModel(id)
      .then(() => {
        setNotice(t(`已删除 ${id}`, `Deleted ${id}`));
        invalidate();
      })
      .catch((removeError: unknown) => setError(removeError instanceof Error ? removeError.message : t("删除失败", "Delete failed")))
      .finally(() => setBusy(false));
  };

  // 双击行进入编辑态：API/内置来源的模型保存后成为手动覆盖（list 合并时手动优先）
  const startEdit = (model: ModelProfile): void => {
    setNotice(undefined);
    setError(undefined);
    setEditing({
      id: model.id,
      provider: model.provider,
      contextWindow: String(model.contextWindow),
      maxOutput: String(model.maxOutput),
      thinking: [...model.capabilities.thinking],
      effort: [...model.capabilities.effort],
      modalities: [...model.capabilities.modalities],
      // The fallback keeps the editor safe while an older local catalog is being upgraded.
      imageOutput: model.capabilities.imageOutput ?? false,
      tools: model.capabilities.tools,
    });
  };

  const cancelEdit = (): void => setEditing(null);

  const toggleCapability = (key: "thinking" | "effort" | "modalities", value: string): void => {
    setEditing((prev) => {
      if (!prev) return prev;
      const selected = prev[key];
      return { ...prev, [key]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] };
    });
  };

  const saveEdit = (): void => {
    if (!editing) return;
    const contextWindow = editing.contextWindow.trim() ? Number(editing.contextWindow) : undefined;
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) {
      setError(t("上下文窗口必须是正整数", "Context window must be a positive integer"));
      return;
    }
    const maxOutput = editing.maxOutput.trim() ? Number(editing.maxOutput) : undefined;
    if (maxOutput !== undefined && (!Number.isSafeInteger(maxOutput) || maxOutput < 1)) {
      setError(t("最大输出必须是正整数", "Maximum output must be a positive integer"));
      return;
    }
    setBusy(true);
    setError(undefined);
    api.saveModel(editing.id, {
      ...(editing.provider.trim() ? { provider: editing.provider.trim() } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      capabilities: {
        thinking: editing.thinking as ModelProfile["capabilities"]["thinking"],
        effort: editing.effort as ModelProfile["capabilities"]["effort"],
        modalities: editing.modalities as ModelProfile["capabilities"]["modalities"],
        imageOutput: editing.imageOutput,
        tools: editing.tools,
      },
    })
      .then(() => {
        setEditing(null);
        setNotice(t(`已保存模型 ${editing.id}`, `Saved model ${editing.id}`));
        invalidate();
      })
      .catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : t("保存失败", "Failed to save")))
      .finally(() => setBusy(false));
  };

  const renderCapGroup = (title: string, options: readonly string[], selected: string[], key: "thinking" | "effort" | "modalities", labels?: Record<string, [string, string]>): ReactElement => (
    <div className="capability-row">
      <span className="capability-title">{title}</span>
      {options.map((option) => (
        <label key={option}>
          <input type="checkbox" checked={selected.includes(option)} onChange={() => toggleCapability(key, option)} />
          {labels?.[option] ? t(...labels[option]!) : option}
        </label>
      ))}
    </div>
  );

  if (models.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (models.isError || !models.data) return <p className="panel-empty">{t("无法加载模型目录。", "Could not load the model catalog.")}</p>;

  return (
    <>
      <p className="settings-note">{t("从已配置凭据的 provider 拉取模型列表；未知模型按内置元数据库保守成档。手动条目永不被刷新覆盖。双击行可编辑模型能力（API/内置模型保存后成为手动覆盖）。", "Fetch models from providers with configured credentials. Unknown models receive conservative built-in metadata; refresh never overwrites manual entries. Double-click a row to edit capabilities.")}</p>
      {syncStatus.data?.updatedAt && <p className="settings-note">{t(
        `上次同步：${new Date(syncStatus.data.updatedAt).toLocaleString(locale)} · ${syncStatus.data.count} 个远程模型`,
        `Last synced: ${new Date(syncStatus.data.updatedAt).toLocaleString(locale)} · ${syncStatus.data.count} remote models`,
      )}</p>}
      <div className="dialog-actions catalog-actions">
        <button className="btn small" disabled={busy} onClick={syncRemote}>{busy ? t("同步中…", "Syncing…") : t("立即同步", "Sync now")}</button>
        <button className="btn small" disabled={busy} onClick={refresh}>{busy ? t("处理中…", "Working…") : t("刷新模型目录", "Refresh catalog")}</button>
      </div>
      {notice && <p className="settings-note">{notice}</p>}
      {error && <p className="settings-error">{error}</p>}
      <table className="pricing-table catalog-table">
        <thead>
          <tr><th>{t("模型", "Model")}</th><th>Provider</th><th>{t("来源", "Source")}</th><th>{t("上下文", "Context")}</th><th>{t("能力", "Capabilities")}</th><th>{t("思考", "Thinking")}</th><th>{t("力度", "Effort")}</th><th></th></tr>
        </thead>
        <tbody>
          {models.data.map((model) => (
            <tr key={model.id} title={t("双击编辑", "Double-click to edit")} onDoubleClick={() => startEdit(model)}>
              <td className="mono">{model.displayName ?? model.id}</td>
              <td>{model.provider}</td>
              <td><span className={`badge badge-source-${model.source ?? "builtin"}`}>{t(...(SOURCE_LABEL[model.source ?? "builtin"] ?? [model.source ?? "builtin", model.source ?? "builtin"]))}</span></td>
              <td className="mono">{model.contextWindow.toLocaleString(locale)}</td>
              <td><ModelCapabilityBadges capabilities={model.capabilities} /></td>
              <td>{model.capabilities.thinking.length > 0 ? model.capabilities.thinking.map((item) => THINKING_LABEL[item] ? t(...THINKING_LABEL[item]!) : item).join(t("、", ", ")) : "—"}</td>
              <td>{model.capabilities.effort.length > 0 ? model.capabilities.effort.join(t("、", ", ")) : "—"}</td>
              <td>{model.source === "manual" && <button className="badge badge-action" disabled={busy} onClick={() => removeManual(model.id)}>{t("删除", "Delete")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? (
        <div className="catalog-edit-form" onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); }}>
          <h4>{t("编辑模型", "Edit model")} <span className="mono">{editing.id}</span></h4>
          <div className="catalog-form">
            <input value={editing.id} disabled aria-label={t("模型 id", "Model ID")} spellCheck={false} />
            <input
              value={editing.provider}
              placeholder="provider"
              onChange={(event) => setEditing((prev) => prev && { ...prev, provider: event.target.value })}
              aria-label="provider"
              spellCheck={false}
            />
            <input
              value={editing.contextWindow}
              placeholder={t("上下文窗口", "Context window")}
              onChange={(event) => setEditing((prev) => prev && { ...prev, contextWindow: event.target.value })}
              aria-label={t("上下文窗口", "Context window")}
              inputMode="numeric"
            />
            <input
              value={editing.maxOutput}
              placeholder={t("最大输出", "Maximum output")}
              onChange={(event) => setEditing((prev) => prev && { ...prev, maxOutput: event.target.value })}
              aria-label={t("最大输出", "Maximum output")}
              inputMode="numeric"
            />
          </div>
          {renderCapGroup(t("思考", "Thinking"), THINKING_OPTIONS, editing.thinking, "thinking", THINKING_LABEL)}
          {renderCapGroup(t("力度", "Effort"), EFFORT_OPTIONS, editing.effort, "effort")}
          {renderCapGroup(t("输入", "Input"), MODALITY_OPTIONS, editing.modalities, "modalities", MODALITY_LABEL)}
          <div className="capability-row">
            <span className="capability-title">{t("图片输出", "Image output")}</span>
            <label>
              <input
                type="checkbox"
                aria-label={t("图片输出", "Image output")}
                checked={editing.imageOutput}
                onChange={(event) => setEditing((prev) => prev && { ...prev, imageOutput: event.target.checked })}
              />
              {t("支持", "Supported")}
            </label>
          </div>
          <div className="capability-row">
            <span className="capability-title">{t("工具", "Tools")}</span>
            <label>
              <input
                type="checkbox"
                checked={editing.tools}
                onChange={(event) => setEditing((prev) => prev && { ...prev, tools: event.target.checked })}
              />
              {t("启用", "Enabled")}
            </label>
          </div>
          <div className="dialog-actions">
            <button className="btn small" disabled={busy} onClick={cancelEdit}>{t("取消（Esc）", "Cancel (Esc)")}</button>
            <button className="btn small primary" disabled={busy} onClick={saveEdit}>{busy ? t("保存中…", "Saving…") : t("保存模型", "Save model")}</button>
          </div>
        </div>
      ) : (
        <div className="catalog-form">
          <input
            value={form.id}
            placeholder={t("模型 id（如 gpt-4o）", "Model ID (for example, gpt-4o)")}
            onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
            aria-label={t("模型 id", "Model ID")}
            spellCheck={false}
          />
          <input
            value={form.provider}
            placeholder={t("provider（新模型必填）", "Provider (required for new models)")}
            onChange={(event) => setForm((prev) => ({ ...prev, provider: event.target.value }))}
            aria-label="provider"
            spellCheck={false}
          />
          <input
            value={form.contextWindow}
            placeholder={t("上下文窗口（可选）", "Context window (optional)")}
            onChange={(event) => setForm((prev) => ({ ...prev, contextWindow: event.target.value }))}
            aria-label={t("上下文窗口", "Context window")}
            inputMode="numeric"
          />
          <button className="btn small" disabled={busy} onClick={addManual}>{t("添加手动模型", "Add manual model")}</button>
        </div>
      )}
    </>
  );
}

function SkillsSection(): ReactElement {
  const { t } = useI18n();
  const skills = useQuery({ queryKey: ["global-skills"], queryFn: api.globalSkills });
  if (skills.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (skills.isError) return <p className="panel-empty">{t("无法加载技能清单。", "Could not load skills.")}</p>;
  return (
    <>
      <p className="settings-note">{t(
        "全局技能放在数据目录 skills/<名称>/SKILL.md，项目技能放在 <工作目录>/.owc/skills/ 下；对话中输入 / 可呼出技能补全，模型也可经 load_skill 工具按需加载。",
        "Place global skills in skills/<name>/SKILL.md under the data directory, and project skills in <workspace>/.owc/skills/. Type / in chat for completion; models can also load them with load_skill.",
      )}</p>
      {skills.data.skills.length === 0 ? (
        <p className="panel-empty">{t("还没有全局技能。", "No global skills installed.")}</p>
      ) : (
        <table className="pricing-table catalog-table">
          <thead>
            <tr><th>{t("名称", "Name")}</th><th>{t("描述", "Description")}</th><th>{t("路径", "Path")}</th></tr>
          </thead>
          <tbody>
            {skills.data.skills.map((skill) => (
              <tr key={skill.name}>
                <td className="mono">/{skill.name}</td>
                <td>{skill.description}</td>
                <td className="mono">{skill.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ExtensionRow({ extension }: { extension: ExtensionInfo }): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const [json, setJson] = useState(() => JSON.stringify(extension.config, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const displayName = language === "en" ? (OFFICIAL_EXTENSION_EN[extension.id]?.name ?? extension.name) : extension.name;
  const displayDescription = language === "en" ? (OFFICIAL_EXTENSION_EN[extension.id]?.description ?? extension.description) : extension.description;

  useEffect(() => setJson(JSON.stringify(extension.config, null, 2)), [extension.config]);

  const update = (body: { enabled?: boolean; config?: Record<string, unknown> }): void => {
    setBusy(true);
    setError(undefined);
    api.configureExtension(extension.id, body)
      .then(() => void queryClient.invalidateQueries({ queryKey: ["extensions"] }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("扩展更新失败", "Extension update failed")))
      .finally(() => setBusy(false));
  };

  const saveConfig = (): void => {
    try {
      const value = JSON.parse(json) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("配置必须是 JSON 对象", "Configuration must be a JSON object"));
      update({ config: value as Record<string, unknown> });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("配置 JSON 无效", "Invalid configuration JSON"));
    }
  };

  return (
    <article className="extension-card">
      <header>
        <div>
          <strong>{displayName}</strong>
          <span className="mono">{extension.id} · v{extension.version}</span>
        </div>
        <label className="extension-switch">
          <input type="checkbox" checked={extension.enabled} disabled={busy} onChange={(event) => update({ enabled: event.target.checked })} />
          {extension.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}
        </label>
      </header>
      <p>{displayDescription}</p>
      <div className="extension-badges">
        {extension.builtIn && <span>{t("官方内置", "Official")}</span>}
        <span className={`extension-status status-${extension.status}`}>{extension.status === "running" ? t("运行中", "Running") : extension.status === "disabled" ? t("已停用", "Disabled") : t("异常", "Error")}</span>
        {extension.permissions.map((permission) => <span key={permission}>{permission}</span>)}
      </div>
      {extension.id === "context-manager" && <p className="settings-note">{t("驱逐、回写和压缩策略按会话配置，请在底部“上下文”面板中调整。", "Eviction, writeback, and compaction policies are configured per session in the Context panel.")}</p>}
      {extension.id !== "context-manager" && <details>
        <summary>{t("配置 JSON", "Configuration JSON")}</summary>
        <textarea className="extension-json mono" rows={7} value={json} disabled={busy} onChange={(event) => setJson(event.target.value)} spellCheck={false} />
        <button className="btn small" disabled={busy} onClick={saveConfig}>{busy ? t("保存中…", "Saving…") : t("保存配置", "Save configuration")}</button>
      </details>}
      {!extension.builtIn && (
        <button className="btn small danger" disabled={busy} onClick={() => {
          if (!window.confirm(t(`卸载扩展 ${displayName}？其配置会一并删除。`, `Uninstall ${displayName}? Its configuration will also be deleted.`))) return;
          setBusy(true); setError(undefined);
          api.uninstallExtension(extension.id)
            .then(() => void queryClient.invalidateQueries({ queryKey: ["extensions"] }))
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("卸载失败", "Uninstall failed")))
            .finally(() => setBusy(false));
        }}>{t("卸载扩展", "Uninstall extension")}</button>
      )}
      {extension.error && <p className="settings-error">{extension.error}</p>}
      {error && <p className="settings-error">{error}</p>}
    </article>
  );
}

function ExtensionsSection(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const extensions = useQuery({ queryKey: ["extensions"], queryFn: api.extensions });
  const [installPath, setInstallPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (extensions.isPending) return <p className="panel-empty">{t("正在连接 Extension Host…", "Connecting to Extension Host…")}</p>;
  if (extensions.isError || !extensions.data) return <p className="panel-empty">{t("无法加载扩展清单。", "Could not load extensions.")}</p>;
  return (
    <>
      <p className="settings-note">{t("扩展运行于独立 Extension Host 子进程；单个钩子超时 5 秒后跳过。v1 扩展是可信代码，安装即代表允许其 manifest 中声明的权限。", "Extensions run in a separate Extension Host process; hooks are skipped after a five-second timeout. v1 extensions are trusted code, and installation grants the permissions declared in their manifest.")}</p>
      <div className="extension-list">{extensions.data.map((extension) => <ExtensionRow key={extension.id} extension={extension} />)}</div>
      <h3>{t("安装本地扩展", "Install local extension")}</h3>
      <p className="settings-note">{t("选择包含 manifest.json 和 index.js 的绝对目录；安装后复制到数据目录 extensions/。", "Enter the absolute path to a directory containing manifest.json and index.js. It will be copied into the data directory's extensions folder.")}</p>
      <div className="settings-inline-form">
        <input value={installPath} onChange={(event) => setInstallPath(event.target.value)} placeholder="D:\\path\\owc-ext-example" spellCheck={false} />
        <button className="btn small" disabled={busy || !installPath.trim()} onClick={() => {
          if (!window.confirm(t("v1 扩展会作为可信代码在独立进程中运行。确认信任并安装此目录中的代码？", "v1 extensions run as trusted code in a separate process. Trust and install the code in this directory?"))) return;
          setBusy(true); setError(undefined);
          api.installExtension(installPath.trim())
            .then(() => { setInstallPath(""); void queryClient.invalidateQueries({ queryKey: ["extensions"] }); })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("安装失败", "Installation failed")))
            .finally(() => setBusy(false));
        }}>{busy ? t("安装中…", "Installing…") : t("安装", "Install")}</button>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </>
  );
}

export function SettingsDialog({ open, preference, setPreference, accent, setAccent, sendKey, setSendKey, defaults, setDefaults, providers, models, onResetLayout, onClose }: {
  open: boolean;
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  accent: AccentPreference;
  setAccent(value: AccentPreference): void;
  sendKey: SendKey;
  setSendKey(value: SendKey): void;
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
  onResetLayout(): void;
  onClose(): void;
}): ReactElement | null {
  const { language, setLanguage, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  // 服务设置的未保存改动由 ServerSettingsSection 上报
  const serverDirtyRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  // 统一关闭入口：有未保存的服务设置改动时先确认
  const requestClose = (): void => {
    if (serverDirtyRef.current && !window.confirm(t("服务设置有未保存的更改，确定放弃？", "Server settings have unsaved changes. Discard them?"))) return;
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      className="session-dialog settings-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
    >
      <div className="settings-body" style={{ position: "relative" }}>
        <button
          className="icon-btn"
          aria-label={t("关闭", "Close")}
          title={t("关闭", "Close")}
          onClick={requestClose}
          style={{ position: "absolute", top: 0, right: 0 }}
        >
          <Icon name="x" size={15} />
        </button>
        <h2>{t("设置", "Settings")}</h2>
        <nav className="settings-nav" aria-label={t("设置分类", "Settings categories")}>
          {TAB_META.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
              aria-current={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.zh, tab.en)}
            </button>
          ))}
        </nav>
        <div className="settings-panel">
          {activeTab === "appearance" && (
            <section>
              <h3>{t("语言", "Language")}</h3>
              <select value={language} aria-label={t("界面语言", "Interface language")} onChange={(event) => setLanguage(event.target.value as Language)}>
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
              <p className="settings-note">{t("语言设置立即生效并保存在本机。", "The language changes immediately and is saved on this device.")}</p>
              <h3>{t("主题", "Theme")}</h3>
              <div className="settings-row" role="radiogroup" aria-label={t("主题", "Theme")}>
                {THEME_OPTIONS.map((option) => (
                  <label key={option.value} className="theme-option">
                    <input
                      type="radio"
                      name="theme"
                      checked={preference === option.value}
                      onChange={() => setPreference(option.value)}
                    />
                    {t(option.zh, option.en)}
                  </label>
                ))}
              </div>
              <h3>{t("强调色", "Accent color")}</h3>
              <div className="settings-row accent-row" role="radiogroup" aria-label={t("强调色", "Accent color")}>
                {ACCENT_OPTIONS.map((option) => (
                  <label key={option.value} className="accent-option">
                    <input
                      type="radio"
                      name="accent"
                      checked={accent === option.value}
                      onChange={() => setAccent(option.value)}
                    />
                    <span className="accent-swatch" style={{ background: option.swatch }} />
                    {t(option.zh, option.en)}
                  </label>
                ))}
              </div>
              <p className="settings-note">{t("强调色影响按钮、链接、高亮等元素；浅色与深色模式各自适配。", "The accent color applies to buttons, links, highlights, and related elements in both light and dark themes.")}</p>
            </section>
          )}
          {activeTab === "general" && (
            <section>
              <h3>{t("发送方式", "Send shortcut")}</h3>
              <div className="settings-row" role="radiogroup" aria-label={t("发送方式", "Send shortcut")}>
                <label className="theme-option">
                  <input type="radio" name="send-key" checked={sendKey === "enter"} onChange={() => setSendKey("enter")} />
                  {t("Enter 发送", "Send with Enter")}
                </label>
                <label className="theme-option">
                  <input type="radio" name="send-key" checked={sendKey === "ctrl-enter"} onChange={() => setSendKey("ctrl-enter")} />
                  {t("Ctrl+Enter 发送", "Send with Ctrl+Enter")}
                </label>
              </div>
              <h3>{t("布局", "Layout")}</h3>
              <p className="settings-note">{t("会话栏宽度/折叠、底部面板高度与开合保存在本机。", "The session rail width and collapsed state, plus bottom-panel height and visibility, are saved locally.")}</p>
              <button className="btn small" onClick={onResetLayout}>{t("重置布局为默认", "Reset layout")}</button>
            </section>
          )}
          {activeTab === "defaults" && (
            <section>
              <h3>{t("会话默认", "Session defaults")}</h3>
              <p className="settings-note">{t("新建会话时预填的取值，可在对话框中再改。", "These values prefill the new-session dialog and can still be changed there.")}</p>
              <DefaultsSection defaults={defaults} setDefaults={setDefaults} providers={providers} models={models} />
            </section>
          )}
          {activeTab === "server" && (
            <section>
              <h3>{t("服务设置", "Server settings")}</h3>
              <ServerSettingsSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
            </section>
          )}
          {activeTab === "models" && (
            <section>
              <h3>{t("模型目录", "Model catalog")}</h3>
              <ModelCatalogSection />
            </section>
          )}
          {activeTab === "skills" && (
            <section>
              <h3>{t("技能", "Skills")}</h3>
              <SkillsSection />
            </section>
          )}
          {activeTab === "extensions" && (
            <section>
              <h3>{t("扩展管理", "Extension management")}</h3>
              <ExtensionsSection />
            </section>
          )}
          {activeTab === "pricing" && (
            <section>
              <h3>{t("模型定价", "Model pricing")}</h3>
              <PricingSection />
            </section>
          )}
          {activeTab === "info" && (
            <section>
              <h3>{t("服务信息", "Server information")}</h3>
              <ServerInfoSection providers={providers} models={models} />
            </section>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={requestClose}>{t("关闭", "Close")}</button>
        </div>
      </div>
    </dialog>
  );
}
