import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ExtensionInfo, ModelInterfaceType, ModelProfile, ModelProviderProfileView, PermissionMode, PricingDocument, SettingsField, SettingValue, UpdateApplyState, WebCapability, WebProviderProfileView, WebProviderType } from "../lib/contracts";
import { formatCurrency } from "../lib/format";
import { Icon, type IconName } from "./Icon";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";
import type { SendKey, SessionDefaults } from "../lib/prefs";
import type { ThemePreference, AccentPreference } from "../theme";
import { useI18n, type Language } from "../i18n";
import { DEFAULT_KEYBINDINGS, formatCombo, isMacPlatform } from "../commands/keybindings";
import { getCommand } from "../commands/registry";

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

type SettingsTab = "appearance" | "general" | "defaults" | "shortcuts" | "server" | "remote" | "models" | "skills" | "extensions" | "pricing" | "prompt" | "info";

interface SettingsTabMeta {
  id: SettingsTab;
  zh: string;
  en: string;
  descriptionZh: string;
  descriptionEn: string;
  icon: IconName;
}

const SETTINGS_GROUPS: Array<{ id: string; zh: string; en: string; tabs: SettingsTabMeta[] }> = [
  {
    id: "preferences",
    zh: "个人偏好",
    en: "Preferences",
    tabs: [
      { id: "appearance", zh: "外观", en: "Appearance", descriptionZh: "语言、主题与界面强调色", descriptionEn: "Language, theme, and interface accent", icon: "sun" },
      { id: "general", zh: "通用", en: "General", descriptionZh: "输入方式与工作区布局", descriptionEn: "Input behavior and workspace layout", icon: "settings" },
      { id: "defaults", zh: "会话默认", en: "Session defaults", descriptionZh: "新会话的模型与运行参数", descriptionEn: "Model and runtime defaults for new sessions", icon: "history" },
      { id: "shortcuts", zh: "快捷键", en: "Shortcuts", descriptionZh: "查看可用的键盘操作", descriptionEn: "Browse available keyboard actions", icon: "terminal" },
    ],
  },
  {
    id: "ai-services",
    zh: "AI 与服务",
    en: "AI & services",
    tabs: [
      { id: "server", zh: "服务设置", en: "Server", descriptionZh: "Provider、执行器与服务端参数", descriptionEn: "Providers, executor, and server options", icon: "wrench" },
      { id: "models", zh: "模型目录", en: "Models", descriptionZh: "同步并维护可用模型能力", descriptionEn: "Sync and maintain model capabilities", icon: "layers" },
      { id: "pricing", zh: "模型定价", en: "Pricing", descriptionZh: "管理 token 价格与计费币种", descriptionEn: "Manage token prices and billing currencies", icon: "chart" },
      { id: "prompt", zh: "提示词", en: "Prompt", descriptionZh: "覆盖系统提示词基线与追加自定义指令", descriptionEn: "Override the system prompt baseline and append custom instructions", icon: "wrench" },
    ],
  },
  {
    id: "capabilities",
    zh: "能力与连接",
    en: "Capabilities",
    tabs: [
      { id: "skills", zh: "技能", en: "Skills", descriptionZh: "查看内置与工作区技能", descriptionEn: "Browse built-in and workspace skills", icon: "check" },
      { id: "extensions", zh: "扩展", en: "Extensions", descriptionZh: "安装、启用与配置扩展", descriptionEn: "Install, enable, and configure extensions", icon: "plus" },
      { id: "remote", zh: "远程访问", en: "Remote access", descriptionZh: "检查网络暴露与访问安全", descriptionEn: "Review network exposure and access security", icon: "shield" },
    ],
  },
  {
    id: "system",
    zh: "系统",
    en: "System",
    tabs: [
      { id: "info", zh: "服务信息", en: "Server info", descriptionZh: "运行状态、版本与连接信息", descriptionEn: "Runtime status, version, and connection details", icon: "alert" },
    ],
  },
];

const TAB_META = SETTINGS_GROUPS.flatMap((group) => group.tabs);

/** 比较两个设置值（数组按元素逐项比较）。 */
function sameValue(left: SettingValue | null | undefined, right: SettingValue | null | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

/** 将设置值格式化为简短的展示文本（用于"安装默认值现为 …"提示）。 */
function formatSettingValue(value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "[]";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

const PERMISSION_OPTIONS: Array<{ value: PermissionMode | ""; zh: string; en: string }> = [
  { value: "", zh: "不预设", en: "Not set" },
  { value: "ask", zh: "每次确认", en: "Ask every time" },
  { value: "acceptEdits", zh: "接受编辑", en: "Accept edits" },
  { value: "yolo", zh: "YOLO", en: "YOLO" },
];

const SETTINGS_GROUP_EN: Record<string, string> = {
  models: "Model catalog sync",
  fastModel: "Fast model",
  general: "Language and currency",
  executor: "Executor",
  service: "Service",
  exchangeRate: "Exchange rate",
};

const SETTINGS_FIELD_EN: Record<string, { label: string; description?: string }> = {
  catalogSyncUrl: { label: "Remote model catalog URL", description: "Leave empty to disable remote model catalog sync" },
  pricingSyncUrl: { label: "Remote pricing catalog URL", description: "Leave empty to disable remote pricing sync" },
  syncIntervalMinutes: { label: "Remote sync interval (minutes)", description: "0 means manual sync only; a value above 0 enables periodic sync (maximum 35,791 minutes)" },
  fastModel: { label: "Fast model", description: "Used for context compaction and Content Lens; models come from the unified catalog of enabled providers" },
  fastModelThinking: { label: "Thinking" },
  fastModelEffort: { label: "Effort" },
  fastModelMaxTokens: { label: "Maximum output limit", description: "Hard output-token ceiling for internal tasks; individual tasks may use a smaller limit" },
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
  const availableModels = models.filter((item) => providers.includes(item.provider));
  const selected = defaults.provider && defaults.model ? JSON.stringify([defaults.provider, defaults.model]) : "";
  return (
    <div className="settings-grid">
      <label>
        {t("默认模型", "Default model")}
        <select
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
            return <option key={value} value={value}>{`${item.id}【${item.provider}】`}</option>;
          })}
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

export function ServerInfoSection({ providers, models }: {
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const { t } = useI18n();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  const version = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: 60_000 });
  const updateCheck = useQuery({ queryKey: ["update-check"], queryFn: api.updateCheck, staleTime: 60_000 });
  const refreshMutation = useMutation({
    mutationFn: api.refreshUpdateCheck,
    onSuccess: () => updateCheck.refetch(),
  });
  const snapshot = updateCheck.data?.snapshot ?? version.data?.latestRelease;
  const latest = snapshot ? {
    version: "latestVersion" in snapshot ? snapshot.latestVersion : snapshot.version,
    isNewer: snapshot.isNewer,
    htmlUrl: snapshot.htmlUrl,
    checkedAt: snapshot.checkedAt,
  } : undefined;

  // 在线更新：点击「立即更新」后轮询 /api/update/apply，终态（done/error）或卸载时停止
  const [applyState, setApplyState] = useState<UpdateApplyState | null>(null);
  const [applyStartError, setApplyStartError] = useState<string>();
  const applyInProgress = Boolean(applyState && applyState.status !== "idle" && applyState.status !== "done" && applyState.status !== "error");

  const startApply = async (): Promise<void> => {
    setApplyStartError(undefined);
    try {
      const { state } = await api.updateApplyStart();
      setApplyState(state);
    } catch (err) {
      setApplyStartError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!applyInProgress) return;
    const timer = setInterval(() => {
      api.updateApplyStatus()
        .then(({ state }) => { if (state) setApplyState(state); })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [applyInProgress]);

  const applyStatusText = (state: UpdateApplyState): string => {
    switch (state.status) {
      case "downloading": {
        const percent = state.progress != null ? ` ${Math.round(state.progress * 100)}%` : "";
        return t(`下载中${percent}`, `Downloading${percent}`);
      }
      case "verifying": return t("校验中…", "Verifying…");
      case "applying": return t("应用中…", "Applying…");
      case "restarting": return t("即将重启…", "Restarting…");
      case "done": return t("完成", "Done");
      case "error": return t("失败", "Failed");
      default: return state.message || t("进行中…", "In progress…");
    }
  };

  return (
    <dl className="server-info">
      <dt>{t("版本", "Version")}</dt>
      <dd>
        {version.data
          ? `Server ${version.data.server} / Core ${version.data.core}${version.data.protocolVersion ? ` (${version.data.protocolVersion})` : ""}`
          : version.isError ? t("不可达", "Unavailable") : t("检查中…", "Checking…")}
      </dd>
      <dt>{t("更新检查", "Update check")}</dt>
      <dd>
        {latest
          ? (latest.isNewer
              ? t(`最新版本 ${latest.version}（可更新）`, `Latest ${latest.version} (update available)`)
              : t(`已是最新（${latest.version}）`, `Up to date (${latest.version})`))
          : updateCheck.isError ? t("未启用", "Not enabled") : t("检查中…", "Checking…")}
        {" "}
        <button
          type="button"
          className="btn small"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
        >
          {refreshMutation.isPending ? t("检查中…", "Checking…") : t("立即检查", "Check now")}
        </button>
        {latest?.isNewer && latest.htmlUrl ? (
          <>
            {" "}
            <a href={latest.htmlUrl} target="_blank" rel="noreferrer">{t("下载", "Download")}</a>
          </>
        ) : null}
        {latest?.isNewer || applyState ? (
          <>
            {" "}
            <button
              type="button"
              className="btn small"
              disabled={applyInProgress}
              onClick={() => void startApply()}
            >
              {applyInProgress
                ? applyStatusText(applyState!)
                : applyState?.status === "error"
                  ? t("重试", "Retry")
                  : t("立即更新", "Update now")}
            </button>
          </>
        ) : null}
        {applyState?.status === "downloading" && applyState.progress != null ? (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuenow={Math.round(applyState.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="update-progress-bar" style={{ width: `${Math.round(applyState.progress * 100)}%` }} />
          </div>
        ) : null}
        {applyState?.status === "restarting" ? (
          <p className="muted">{t("服务即将重启，更新后请刷新页面。", "The service is restarting; refresh the page after the update.")}</p>
        ) : null}
        {applyState?.status === "done" ? (
          <p className="muted">{t("更新已应用，请手动重启服务后刷新页面。", "Update applied. Restart the service manually, then refresh the page.")}</p>
        ) : null}
        {applyState?.status === "error" ? (
          <p className="settings-error" role="alert">{t("更新失败：", "Update failed: ")}{applyState.error ?? applyState.message}</p>
        ) : null}
        {applyStartError ? <p className="settings-error" role="alert">{applyStartError}</p> : null}
      </dd>
      <dt>{t("API 状态", "API status")}</dt>
      <dd>{health.data?.status === "ok" ? t("在线", "Online") : health.isError ? t("不可达", "Unavailable") : t("检查中…", "Checking…")}</dd>
      <dt>Providers</dt>
      <dd>{providers.length > 0 ? providers.join("、") : "-"}</dd>
      <dt>{t("模型档案", "Model profiles")}</dt>
      <dd>{t(`${models.length} 个`, `${models.length}`)}</dd>
    </dl>
  );
}

function PromptSection(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const prompt = useQuery({ queryKey: ["prompt-override"], queryFn: () => api.promptOverride() });
  const [baseOverride, setBaseOverride] = useState("");
  const [customAppend, setCustomAppend] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!prompt.data || initialized) return;
    setBaseOverride(prompt.data.baseOverride ?? "");
    setCustomAppend(prompt.data.customAppend ?? "");
    setInitialized(true);
  }, [prompt.data, initialized]);

  const save = async (body: { baseOverride?: string | null; customAppend?: string | null }): Promise<void> => {
    setSaving(true);
    setNotice(undefined);
    setError(undefined);
    try {
      await api.savePromptOverride(body);
      void queryClient.invalidateQueries({ queryKey: ["prompt-override"] });
      setNotice(t("已保存", "Saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const data = prompt.data;
  return (
    <div className="prompt-section">
      <p className="muted">
        {t(
          "提示词不是安全边界：plan 模式、权限与沙箱由服务独立强制，不受此处覆盖影响。项目级 .owc/system-prompt.md 会覆盖全局设置。",
          "The prompt is not a security boundary: plan mode, permissions, and sandbox are enforced independently. Project-level .owc/system-prompt.md overrides these global settings.",
        )}
      </p>
      {data ? (
        <details className="prompt-builtin">
          <summary>{t(`内置基线（${data.promptVersion}）`, `Built-in baseline (${data.promptVersion})`)}</summary>
          <pre className="prompt-builtin-text">{data.builtinBase}</pre>
        </details>
      ) : null}
      <label className="settings-field">
        <span>{t("全局基线覆盖", "Global baseline override")}</span>
        <textarea
          rows={6}
          value={baseOverride}
          placeholder={t("留空则使用内置基线", "Leave empty to use the built-in baseline")}
          onChange={(event) => setBaseOverride(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>{t("全局追加指令", "Global custom instructions")}</span>
        <textarea
          rows={6}
          value={customAppend}
          placeholder={t("追加到安全约束之后的自定义指令", "Custom instructions appended after safety constraints")}
          onChange={(event) => setCustomAppend(event.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <button
          className="btn primary"
          disabled={saving}
          onClick={() => void save({ baseOverride: baseOverride.trim() === "" ? null : baseOverride, customAppend: customAppend.trim() === "" ? null : customAppend })}
        >
          {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
        </button>
        <button
          className="btn"
          disabled={saving}
          onClick={() => void save({ baseOverride: null, customAppend: null })}
        >
          {t("恢复内置基线", "Restore built-in baseline")}
        </button>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

interface ModelProviderForm {
  originalId?: string;
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  baseURL: string;
  apiKey: string;
  promptCaching: boolean;
  clearApiKey: boolean;
}

const emptyModelProvider = (): ModelProviderForm => ({
  id: "",
  enabled: true,
  interfaceType: "openai-chat-completions",
  baseURL: "",
  apiKey: "",
  promptCaching: true,
  clearApiKey: false,
});

interface WebProviderForm {
  originalId?: string;
  id: string;
  provider: WebProviderType;
  capabilities: WebCapability[];
  apiKey: string;
  searchBaseURL: string;
  fetchBaseURL: string;
  clearApiKey: boolean;
}

const emptyWebProvider = (): WebProviderForm => ({
  id: "",
  provider: "brave",
  capabilities: ["search"],
  apiKey: "",
  searchBaseURL: "",
  fetchBaseURL: "",
  clearApiKey: false,
});

export function ProviderProfilesSection(): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["provider-profiles"], queryFn: api.providerProfiles });
  const [modelForm, setModelForm] = useState<ModelProviderForm>(emptyModelProvider);
  const [webForm, setWebForm] = useState<WebProviderForm>(emptyWebProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const accepted = (view: Awaited<ReturnType<typeof api.providerProfiles>>): void => {
    queryClient.setQueryData(["provider-profiles"], view);
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    setError(undefined);
  };
  const run = (operation: Promise<Awaited<ReturnType<typeof api.providerProfiles>>>, done?: () => void): void => {
    setBusy(true);
    setError(undefined);
    operation.then((view) => { accepted(view); done?.(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("保存失败", "Failed to save")))
      .finally(() => setBusy(false));
  };

  if (profiles.isPending) return <p className="panel-empty">{t("加载服务商配置…", "Loading provider profiles…")}</p>;
  if (profiles.isError || !profiles.data) return <p className="settings-error">{t("无法加载服务商配置。", "Could not load provider profiles.")}</p>;

  const editModel = (profile: ModelProviderProfileView): void => setModelForm({
    originalId: profile.id,
    id: profile.id,
    enabled: profile.enabled,
    interfaceType: profile.interfaceType,
    baseURL: profile.baseURL ?? "",
    apiKey: "",
    promptCaching: profile.promptCaching !== false,
    clearApiKey: false,
  });
  const saveModelProvider = (): void => {
    const id = modelForm.id.trim();
    if (!id) { setError(t("模型服务商名称不能为空", "Model provider name is required")); return; }
    const body: Record<string, unknown> = {
      id,
      enabled: modelForm.enabled,
      interfaceType: modelForm.interfaceType,
      ...(modelForm.baseURL.trim() ? { baseURL: modelForm.baseURL.trim() } : { baseURL: null }),
      ...(modelForm.interfaceType === "anthropic-messages" ? { promptCaching: modelForm.promptCaching } : {}),
      ...(modelForm.clearApiKey ? { apiKey: null } : modelForm.apiKey.trim() ? { apiKey: modelForm.apiKey.trim() } : {}),
    };
    run(modelForm.originalId ? api.saveModelProvider(modelForm.originalId, body) : api.createModelProvider(body), () => setModelForm(emptyModelProvider()));
  };
  const modelLabel = (profile: ModelProviderProfileView): string => profile.interfaceType === "anthropic-messages" ? "Anthropic Messages" : "OpenAI Chat Completions";

  const editWeb = (profile: WebProviderProfileView): void => setWebForm({
    originalId: profile.id,
    id: profile.id,
    provider: profile.provider,
    capabilities: [...profile.capabilities],
    apiKey: "",
    searchBaseURL: profile.searchBaseURL ?? "",
    fetchBaseURL: profile.fetchBaseURL ?? "",
    clearApiKey: false,
  });
  const normalizedCapabilities = (provider: WebProviderType, selected: WebCapability[]): WebCapability[] => provider === "jina"
    ? ["search", "fetch"]
    : provider === "tavily" ? ["search", "fetch"]
      : provider === "brave" ? ["search"] : selected;
  const saveWebProvider = (): void => {
    const id = webForm.id.trim();
    if (!id) { setError(t("联网服务商名称不能为空", "Web provider name is required")); return; }
    const body: Record<string, unknown> = {
      id,
      provider: webForm.provider,
      capabilities: normalizedCapabilities(webForm.provider, webForm.capabilities),
      ...(webForm.searchBaseURL.trim() ? { searchBaseURL: webForm.searchBaseURL.trim() } : { searchBaseURL: null }),
      ...(webForm.fetchBaseURL.trim() ? { fetchBaseURL: webForm.fetchBaseURL.trim() } : { fetchBaseURL: null }),
      ...(webForm.clearApiKey ? { apiKey: null } : webForm.apiKey.trim() ? { apiKey: webForm.apiKey.trim() } : {}),
    };
    run(webForm.originalId ? api.saveWebProvider(webForm.originalId, body) : api.createWebProvider(body), () => setWebForm(emptyWebProvider()));
  };
  const toggleWebCapability = (capability: WebCapability): void => setWebForm((current) => ({
    ...current,
    capabilities: current.capabilities.includes(capability)
      ? current.capabilities.filter((item) => item !== capability)
      : [...current.capabilities, capability],
  }));

  return (
    <>
      <div className="server-settings-group">
        <h4>{t("模型服务商", "Model providers")}</h4>
        <p className="settings-note">{t("可保存多个服务商配置。启用后自动注册并拉取该服务商模型；模型选择器统一显示为 模型ID【服务商】。", "Save multiple provider profiles. Enabled profiles are registered and their models are fetched; the model picker shows Model ID【Provider】.")}</p>
        {profiles.data.modelProviders.length > 0 && (
          <table className="pricing-table catalog-table">
            <thead><tr><th>{t("名称", "Name")}</th><th>{t("接口类型", "Interface")}</th><th>{t("状态", "Status")}</th><th>API Key</th><th></th></tr></thead>
            <tbody>{profiles.data.modelProviders.map((profile) => (
              <tr key={profile.id}>
                <td className="mono">{profile.id}</td><td>{modelLabel(profile)}</td>
                <td>{profile.enabled ? t("启用", "Enabled") : t("停用", "Disabled")}</td>
                <td>{profile.maskedApiKey ?? "—"}</td>
                <td><button className="badge badge-action" disabled={busy} onClick={() => editModel(profile)}>{t("编辑", "Edit")}</button>{" "}<button className="badge badge-action" disabled={busy} onClick={() => { if (window.confirm(t(`删除模型服务商「${profile.id}」？`, `Delete model provider “${profile.id}”?`))) run(api.deleteModelProvider(profile.id)); }}>{t("删除", "Delete")}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="catalog-edit-form">
          <h4>{modelForm.originalId ? t("编辑模型服务商", "Edit model provider") : t("添加模型服务商", "Add model provider")}</h4>
          <div className="catalog-form">
            <input value={modelForm.id} disabled={Boolean(modelForm.originalId)} placeholder={t("服务商名称", "Provider name")} onChange={(event) => setModelForm((current) => ({ ...current, id: event.target.value }))} />
            <select value={modelForm.interfaceType} onChange={(event) => setModelForm((current) => ({ ...current, interfaceType: event.target.value as ModelInterfaceType }))}>
              <option value="openai-chat-completions">OpenAI Chat Completions</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
            <input value={modelForm.baseURL} placeholder={t("Base URL（留空使用官方地址）", "Base URL (blank for official endpoint)")} onChange={(event) => setModelForm((current) => ({ ...current, baseURL: event.target.value }))} spellCheck={false} />
            <input type="password" value={modelForm.apiKey} placeholder={modelForm.originalId ? t("API Key（留空保留）", "API Key (blank keeps current)") : "API Key"} onChange={(event) => setModelForm((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }))} autoComplete="off" />
          </div>
          <div className="settings-row">
            <label className="theme-option"><input type="checkbox" checked={modelForm.enabled} onChange={(event) => setModelForm((current) => ({ ...current, enabled: event.target.checked }))} />{t("启用", "Enabled")}</label>
            {modelForm.interfaceType === "anthropic-messages" && <label className="theme-option"><input type="checkbox" checked={modelForm.promptCaching} onChange={(event) => setModelForm((current) => ({ ...current, promptCaching: event.target.checked }))} />Prompt caching</label>}
            {modelForm.originalId && <label className="theme-option"><input type="checkbox" checked={modelForm.clearApiKey} onChange={(event) => setModelForm((current) => ({ ...current, clearApiKey: event.target.checked, apiKey: "" }))} />{t("清除 API Key", "Clear API key")}</label>}
          </div>
          <div className="dialog-actions"><button className="btn small" disabled={busy} onClick={() => setModelForm(emptyModelProvider())}>{t("取消", "Cancel")}</button><button className="btn small primary" disabled={busy} onClick={saveModelProvider}>{t("保存服务商", "Save provider")}</button></div>
        </div>
      </div>

      <div className="server-settings-group">
        <h4>{t("联网服务商", "Web providers")}</h4>
        <p className="settings-note">{t("Search 与 Fetch 合并管理；每个配置声明能力，再分别选择当前使用的配置。", "Search and Fetch share one registry. Each profile declares capabilities, then an active profile is selected for each capability.")}</p>
        <div className="settings-grid">
          {(["search", "fetch"] as const).map((capability) => (
            <label key={capability}>{capability === "search" ? "Web Search" : "Web Fetch"}
              <select value={profiles.data.activeWeb[capability] ?? ""} onChange={(event) => run(api.selectWebProvider(capability, event.target.value || null))}>
                <option value="">{t("不启用", "Disabled")}</option>
                {profiles.data.webProviders.filter((item) => item.capabilities.includes(capability)).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
          ))}
        </div>
        {profiles.data.webProviders.length > 0 && (
          <table className="pricing-table catalog-table"><thead><tr><th>{t("名称", "Name")}</th><th>{t("类型", "Type")}</th><th>{t("能力", "Capabilities")}</th><th>API Key</th><th></th></tr></thead>
            <tbody>{profiles.data.webProviders.map((profile) => <tr key={profile.id}><td className="mono">{profile.id}</td><td>{profile.provider}</td><td>{profile.capabilities.join(" + ")}</td><td>{profile.maskedApiKey ?? "—"}</td><td><button className="badge badge-action" disabled={busy} onClick={() => editWeb(profile)}>{t("编辑", "Edit")}</button>{" "}<button className="badge badge-action" disabled={busy} onClick={() => { if (window.confirm(t(`删除联网服务商「${profile.id}」？`, `Delete web provider “${profile.id}”?`))) run(api.deleteWebProvider(profile.id)); }}>{t("删除", "Delete")}</button></td></tr>)}</tbody>
          </table>
        )}
        <div className="catalog-edit-form">
          <h4>{webForm.originalId ? t("编辑联网服务商", "Edit web provider") : t("添加联网服务商", "Add web provider")}</h4>
          <div className="catalog-form">
            <input value={webForm.id} disabled={Boolean(webForm.originalId)} placeholder={t("配置名称", "Profile name")} onChange={(event) => setWebForm((current) => ({ ...current, id: event.target.value }))} />
            <select value={webForm.provider} onChange={(event) => { const provider = event.target.value as WebProviderType; setWebForm((current) => ({ ...current, provider, capabilities: normalizedCapabilities(provider, current.capabilities) })); }}><option value="brave">Brave</option><option value="tavily">Tavily</option><option value="jina">Jina</option><option value="custom">Custom</option></select>
            <input type="password" value={webForm.apiKey} placeholder={webForm.originalId ? t("API Key（留空保留）", "API Key (blank keeps current)") : "API Key"} onChange={(event) => setWebForm((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }))} autoComplete="off" />
          </div>
          {webForm.provider === "custom" && <div className="settings-row"><label className="theme-option"><input type="checkbox" checked={webForm.capabilities.includes("search")} onChange={() => toggleWebCapability("search")} />Search</label><label className="theme-option"><input type="checkbox" checked={webForm.capabilities.includes("fetch")} onChange={() => toggleWebCapability("fetch")} />Fetch</label></div>}
          <div className="catalog-form">
            {(webForm.provider === "custom" && webForm.capabilities.includes("search")) && <input value={webForm.searchBaseURL} placeholder="Search Base URL" onChange={(event) => setWebForm((current) => ({ ...current, searchBaseURL: event.target.value }))} spellCheck={false} />}
            {(webForm.provider === "custom" && webForm.capabilities.includes("fetch")) && <input value={webForm.fetchBaseURL} placeholder="Fetch Base URL（含 {url}）" onChange={(event) => setWebForm((current) => ({ ...current, fetchBaseURL: event.target.value }))} spellCheck={false} />}
          </div>
          {webForm.originalId && <label className="theme-option"><input type="checkbox" checked={webForm.clearApiKey} onChange={(event) => setWebForm((current) => ({ ...current, clearApiKey: event.target.checked, apiKey: "" }))} />{t("清除 API Key", "Clear API key")}</label>}
          <div className="dialog-actions"><button className="btn small" disabled={busy} onClick={() => setWebForm(emptyWebProvider())}>{t("取消", "Cancel")}</button><button className="btn small primary" disabled={busy} onClick={saveWebProvider}>{t("保存服务商", "Save provider")}</button></div>
        </div>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </>
  );
}

export function ServerSettingsSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
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
        <select value={resetting ? "" : value} disabled={disabled} onChange={(event) => setField(field.key, event.target.value || (field.nullable ? null : ""))} aria-label={fieldLabel(field)}>
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
          ...(field.key === "syncIntervalMinutes" ? { max: MAX_SYNC_INTERVAL_MINUTES } : field.key === "fastModelMaxTokens" ? { max: 64_000 } : {}),
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
        {!resetting && field.source === "file" && field.installDefault !== undefined && !sameValue(field.value, field.installDefault) && (
          <p className="settings-note">{t(`安装默认值现为 ${formatSettingValue(field.installDefault)}，可点「重置」采纳`, `Install default is now ${formatSettingValue(field.installDefault)}; click "Reset" to adopt`)}</p>
        )}
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
  originalProvider: string;
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
  const providerProfiles = useQuery({ queryKey: ["provider-profiles"], queryFn: api.providerProfiles });
  const enabledProviders = providerProfiles.data?.modelProviders.filter((item) => item.enabled).map((item) => item.id) ?? [];
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: "", provider: "", contextWindow: "" });
  const [editing, setEditing] = useState<ModelEditForm | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["model-sync-status"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
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

  const removeManual = (id: string, provider: string): void => {
    if (!window.confirm(t(`删除手动模型「${id}【${provider}】」？`, `Delete manual model “${id}【${provider}】”?`))) return;
    setBusy(true);
    setError(undefined);
    api.deleteModel(id, provider)
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
      originalProvider: model.provider,
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
      originalProvider: editing.originalProvider,
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
            <tr key={`${model.provider}\u0000${model.id}`} title={t("双击编辑", "Double-click to edit")} onDoubleClick={() => startEdit(model)}>
              <td className="mono">{model.displayName ?? model.id}</td>
              <td>{model.provider}</td>
              <td><span className={`badge badge-source-${model.source ?? "builtin"}`}>{t(...(SOURCE_LABEL[model.source ?? "builtin"] ?? [model.source ?? "builtin", model.source ?? "builtin"]))}</span></td>
              <td className="mono">{model.contextWindow.toLocaleString(locale)}</td>
              <td><ModelCapabilityBadges capabilities={model.capabilities} /></td>
              <td>{model.capabilities.thinking.length > 0 ? model.capabilities.thinking.map((item) => THINKING_LABEL[item] ? t(...THINKING_LABEL[item]!) : item).join(t("、", ", ")) : "—"}</td>
              <td>{model.capabilities.effort.length > 0 ? model.capabilities.effort.join(t("、", ", ")) : "—"}</td>
              <td>{model.source === "manual" && <button className="badge badge-action" disabled={busy} onClick={() => removeManual(model.id, model.provider)}>{t("删除", "Delete")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing ? (
        <div className="catalog-edit-form" onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); }}>
          <h4>{t("编辑模型", "Edit model")} <span className="mono">{editing.id}</span></h4>
          <div className="catalog-form">
            <input value={editing.id} disabled aria-label={t("模型 id", "Model ID")} spellCheck={false} />
            <select
              value={editing.provider}
              onChange={(event) => setEditing((prev) => prev && { ...prev, provider: event.target.value })}
              aria-label="provider"
            >
              {!enabledProviders.includes(editing.provider) && <option value={editing.provider}>{editing.provider}</option>}
              {enabledProviders.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
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
          <select
            value={form.provider}
            onChange={(event) => setForm((prev) => ({ ...prev, provider: event.target.value }))}
            aria-label="provider"
          >
            <option value="">{t("选择服务商", "Select provider")}</option>
            {enabledProviders.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
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

/**
 * 快捷键分区（0.4.0 Phase 5b）：如实列出默认键位集与命令标题（与速查表同源）。
 * 0.4.0 不支持自定义键位，仅展示。
 */
export function ShortcutsSection(): ReactElement {
  const { t } = useI18n();
  const isMac = isMacPlatform();
  return (
    <>
      <p className="settings-note">{t("默认键位集（暂不支持自定义）。mod 在 Windows/Linux 为 Ctrl，macOS 为 Cmd。", "Default keybindings (customization is not supported yet). mod is Ctrl on Windows/Linux and Cmd on macOS.")}</p>
      <table className="shortcuts-table">
        <tbody>
          {DEFAULT_KEYBINDINGS.map((binding) => {
            const command = getCommand(binding.command);
            return (
              <tr key={`${binding.command}-${binding.key}`}>
                <td>{command ? t(command.title.zh, command.title.en) : binding.command}</td>
                <td><kbd>{formatCombo(binding.key, isMac)}</kbd></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 远程访问分区（0.4.0 Phase 5b §6.8）：展示监听地址与 token 认证配置状态，
 * 非回环监听时持续展示风险提示。只读展示；修改仍在“服务设置”分区（host/port）或服务端环境变量。
 */
export function RemoteAccessSection(): ReactElement {
  const { t } = useI18n();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  if (settings.isPending) return <p className="panel-empty">{t("加载中…", "Loading…")}</p>;
  if (settings.isError || !settings.data) return <p className="panel-empty">{t("无法加载服务设置。", "Could not load server settings.")}</p>;
  const service = settings.data.groups.find((group) => group.id === "service");
  const hostField = service?.fields.find((field) => field.key === "host");
  const portField = service?.fields.find((field) => field.key === "port");
  const host = String(hostField?.value ?? hostField?.masked ?? "127.0.0.1");
  const loopback = LOOPBACK_HOSTS.has(host);
  return (
    <>
      <dl className="server-info">
        <dt>{t("监听地址", "Listen address")}</dt>
        <dd className="mono">{host}{portField?.value != null ? `:${String(portField.value)}` : ""}</dd>
        <dt>{t("访问范围", "Exposure")}</dt>
        <dd>{loopback ? t("仅本机回环（默认，安全）", "Loopback only (default, safe)") : t("非回环监听：局域网/外部可达", "Non-loopback: reachable from the LAN/network")}</dd>
        <dt>{t("Token 认证", "Token authentication")}</dt>
        <dd>{t("由服务端 OWC_ACCESS_TOKEN 环境变量配置；非回环监听时必须设置（服务端强制，未设置会拒绝启动）。", "Configured via the server's OWC_ACCESS_TOKEN environment variable; required for non-loopback listeners (enforced by the server at startup).")}</dd>
      </dl>
      {!loopback && (
        <p className="settings-error" role="alert">{t(
          "风险：当前服务对网络可达。请确认已设置 OWC_ACCESS_TOKEN 与 OWC_ALLOWED_ORIGINS，且只在受信网络中暴露；任何人持有 token 即可操作你的会话与工具。",
          "Risk: the server is reachable from the network. Make sure OWC_ACCESS_TOKEN and OWC_ALLOWED_ORIGINS are set and only expose it on trusted networks; anyone with the token can drive your sessions and tools.",
        )}</p>
      )}
      <p className="settings-note">{t(
        "移动端/局域网访问：将“服务设置”中的监听地址改为 0.0.0.0（需重启），并在服务端环境变量中配置 OWC_ACCESS_TOKEN（≥32 字符）与 OWC_ALLOWED_ORIGINS。浏览器首次用 ?token= 打开后会写入 HttpOnly Cookie。修改监听地址后重启服务生效。",
        "Mobile/LAN access: set the listen address to 0.0.0.0 in Server settings (restart required), and configure OWC_ACCESS_TOKEN (at least 32 characters) plus OWC_ALLOWED_ORIGINS as server environment variables. Opening the page once with ?token= stores an HttpOnly cookie. Restart the server after changing the listen address.",
      )}</p>
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
  const contentRef = useRef<HTMLDivElement>(null);
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

  const selectTab = (tab: SettingsTab): void => {
    setActiveTab(tab);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    contentRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  const activeMeta = TAB_META.find((tab) => tab.id === activeTab) ?? TAB_META[0];

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
      <div className="settings-body">
        <header className="settings-dialog-header">
          <div className="settings-dialog-title">
            <span className="settings-title-icon"><Icon name="settings" size={18} /></span>
            <div>
              <h2>{t("设置", "Settings")}</h2>
              <p>{t("个性化 OpenWebCode，并管理模型与服务", "Personalize OpenWebCode and manage models and services")}</p>
            </div>
          </div>
          <button className="icon-btn settings-close" aria-label={t("关闭", "Close")} title={t("关闭", "Close")} onClick={requestClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("设置分类", "Settings categories")}>
            {SETTINGS_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.id}>
                <span className="settings-nav-label">{t(group.zh, group.en)}</span>
                {group.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    data-settings-tab={tab.id}
                    className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => {
                      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
                      event.preventDefault();
                      const index = TAB_META.findIndex((item) => item.id === tab.id);
                      const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                      const next = TAB_META[(index + offset + TAB_META.length) % TAB_META.length];
                      selectTab(next.id);
                      dialogRef.current?.querySelector<HTMLElement>(`[data-settings-tab="${next.id}"]`)?.focus();
                    }}
                  >
                    <Icon name={tab.icon} size={15} />
                    <span>{t(tab.zh, tab.en)}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <main className="settings-content">
            <header className="settings-content-header">
              <span className="settings-section-icon"><Icon name={activeMeta.icon} size={18} /></span>
              <div>
                <h3 id="settings-section-title">{t(activeMeta.zh, activeMeta.en)}</h3>
                <p>{t(activeMeta.descriptionZh, activeMeta.descriptionEn)}</p>
              </div>
            </header>
            <div ref={contentRef} className="settings-panel" key={activeTab} aria-labelledby="settings-section-title">
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
          {activeTab === "shortcuts" && (
            <section>
              <h3>{t("键盘快捷方式", "Keyboard Shortcuts")}</h3>
              <ShortcutsSection />
            </section>
          )}
          {activeTab === "remote" && (
            <section>
              <h3>{t("远程访问", "Remote access")}</h3>
              <RemoteAccessSection />
            </section>
          )}
          {activeTab === "server" && (
            <section>
              <h3>{t("服务设置", "Server settings")}</h3>
              <ProviderProfilesSection />
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
          {activeTab === "prompt" && (
            <section>
              <h3>{t("提示词", "System prompt")}</h3>
              <PromptSection />
            </section>
          )}
          {activeTab === "info" && (
            <section>
              <h3>{t("服务信息", "Server information")}</h3>
              <ServerInfoSection providers={providers} models={models} />
            </section>
          )}
            </div>
            <div className="dialog-actions settings-actions">
              <button className="btn" onClick={requestClose}>{t("完成", "Done")}</button>
            </div>
          </main>
        </div>
      </div>
    </dialog>
  );
}
