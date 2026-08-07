import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ModelInterfaceType, ModelProviderProfileView, ProviderProfilesView, WebCapability, WebProviderProfileView, WebProviderType } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import { ProxySection } from "./ProxySection";
import { useConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";

interface ModelProviderForm {
  originalId?: string;
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  baseURL: string;
  apiKey: string;
  promptCaching: boolean;
  extraBody: string;
  clearApiKey: boolean;
}

const emptyModelProvider = (): ModelProviderForm => ({
  id: "",
  enabled: true,
  interfaceType: "openai-chat-completions",
  baseURL: "",
  apiKey: "",
  promptCaching: true,
  extraBody: "",
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

/** 两个分区共用的 profiles 变更通道：写回缓存、失效派生查询、busy/error 状态。 */
function useProfileOps(): {
  busy: boolean;
  error: string | undefined;
  setError(value: string | undefined): void;
  run(operation: Promise<ProviderProfilesView>, done?: () => void): void;
} {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const accepted = (view: ProviderProfilesView): void => {
    queryClient.setQueryData(["provider-profiles"], view);
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    setError(undefined);
  };
  const run = (operation: Promise<ProviderProfilesView>, done?: () => void): void => {
    setBusy(true);
    setError(undefined);
    operation.then((view) => { accepted(view); done?.(); })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("保存失败", "Failed to save")))
      .finally(() => setBusy(false));
  };
  return { busy, error, setError, run };
}

const providerProfilesQuery = { queryKey: ["provider-profiles"], queryFn: () => api.providerProfiles() } as const;

/** 「模型目录」页签：模型服务商 CRUD + 连接测试 + 自定义请求体。 */
export function ModelProvidersSection(): ReactElement {
  const { t } = useI18n();
  const profiles = useQuery(providerProfilesQuery);
  const { busy, error, setError, run } = useProfileOps();
  const [modelForm, setModelForm] = useState<ModelProviderForm>(emptyModelProvider);
  type ConnectionTest = { status: "idle" } | { status: "pending" } | { status: "ok"; latencyMs: number; note?: string } | { status: "fail"; error: string };
  const [connectionTest, setConnectionTest] = useState<ConnectionTest>({ status: "idle" });
  const confirm = useConfirmDialog();

  if (profiles.isPending) return <p className="muted-empty panel-empty">{t("加载服务商配置…", "Loading provider profiles…")}</p>;
  if (profiles.isError || !profiles.data) return <p className="settings-error">{t("无法加载服务商配置。", "Could not load provider profiles.")}</p>;

  const editModel = (profile: ModelProviderProfileView): void => {
    setConnectionTest({ status: "idle" });
    setModelForm({
      originalId: profile.id,
      id: profile.id,
      enabled: profile.enabled,
      interfaceType: profile.interfaceType,
      baseURL: profile.baseURL ?? "",
      apiKey: "",
      promptCaching: profile.promptCaching !== false,
      extraBody: profile.extraBody ? JSON.stringify(profile.extraBody, null, 2) : "",
      clearApiKey: false,
    });
  };
  const saveModelProvider = (): void => {
    const id = modelForm.id.trim();
    if (!id) { setError(t("模型服务商名称不能为空", "Model provider name is required")); return; }
    let extraBody: Record<string, unknown> | null = null;
    const extraBodyText = modelForm.extraBody.trim();
    if (extraBodyText) {
      try {
        const parsed: unknown = JSON.parse(extraBodyText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        extraBody = parsed as Record<string, unknown>;
      } catch {
        setError(t("自定义请求体不是合法的 JSON 对象", "Custom request body is not a valid JSON object"));
        return;
      }
    }
    const body: Record<string, unknown> = {
      id,
      enabled: modelForm.enabled,
      interfaceType: modelForm.interfaceType,
      ...(modelForm.baseURL.trim() ? { baseURL: modelForm.baseURL.trim() } : { baseURL: null }),
      ...(modelForm.interfaceType === "anthropic-messages" ? { promptCaching: modelForm.promptCaching } : {}),
      extraBody,
      ...(modelForm.clearApiKey ? { apiKey: null } : modelForm.apiKey.trim() ? { apiKey: modelForm.apiKey.trim() } : {}),
    };
    run(modelForm.originalId ? api.saveModelProvider(modelForm.originalId, body) : api.createModelProvider(body), () => setModelForm(emptyModelProvider()));
  };
  // 用表单当前值（未保存）做连接测试；编辑旧配置且 API Key 留空时会按“无 Key”测试
  const testModelConnection = (): void => {
    const id = modelForm.id.trim();
    if (!id) { setConnectionTest({ status: "fail", error: t("请先填写服务商名称", "Enter a provider name first") }); return; }
    setConnectionTest({ status: "pending" });
    api.testModelProvider({
      id,
      enabled: modelForm.enabled,
      interfaceType: modelForm.interfaceType,
      ...(modelForm.baseURL.trim() ? { baseURL: modelForm.baseURL.trim() } : {}),
      ...(modelForm.apiKey.trim() ? { apiKey: modelForm.apiKey.trim() } : {}),
    }).then((result) => {
      setConnectionTest(result.ok
        ? { status: "ok", latencyMs: result.latencyMs ?? 0, ...(result.note ? { note: result.note } : {}) }
        : { status: "fail", error: result.error ?? t("连接测试失败", "Connection test failed") });
    }).catch((reason: unknown) => {
      setConnectionTest({ status: "fail", error: reason instanceof Error ? reason.message : t("连接测试失败", "Connection test failed") });
    });
  };
  const INTERFACE_LABELS: Record<ModelInterfaceType, string> = {
    "anthropic-messages": "Anthropic Messages",
    "openai-chat-completions": "OpenAI Chat Completions",
    "openai-responses": "OpenAI Responses",
  };
  const modelLabel = (profile: ModelProviderProfileView): string => INTERFACE_LABELS[profile.interfaceType];

  // 表单字段变动后，之前的连接测试结果不再对应，重置为 idle
  const updateModelForm = (patch: Partial<ModelProviderForm>): void => {
    setConnectionTest({ status: "idle" });
    setModelForm((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="server-settings-group">
      <h4>{t("模型服务商", "Model providers")}</h4>
      <p className="settings-note">{t("可保存多个服务商配置。启用后自动注册并拉取该服务商模型；模型选择器统一显示为 模型ID【服务商】。", "Save multiple provider profiles. Enabled profiles are registered and their models are fetched; the model picker shows Model ID (Provider).")}</p>
      {profiles.data.modelProviders.length > 0 && (
        <table className="pricing-table catalog-table">
          <thead><tr><th>{t("名称", "Name")}</th><th>{t("接口类型", "Interface")}</th><th>{t("状态", "Status")}</th><th>API Key</th><th></th></tr></thead>
          <tbody>{profiles.data.modelProviders.map((profile) => (
            <tr key={profile.id}>
              <td className="mono">{profile.id}</td><td>{modelLabel(profile)}</td>
              <td>{profile.enabled ? t("启用", "Enabled") : t("停用", "Disabled")}</td>
              <td>{profile.maskedApiKey ?? "—"}</td>
              <td><button className="btn small" disabled={busy} onClick={() => editModel(profile)}>{t("编辑", "Edit")}</button>{" "}<button className="btn small" disabled={busy} onClick={() => confirm.ask({ title: t("删除模型服务商", "Delete model provider"), body: t(`删除模型服务商「${profile.id}」？`, `Delete model provider “${profile.id}”?`), confirmLabel: t("删除", "Delete"), onConfirm: () => run(api.deleteModelProvider(profile.id)) })}>{t("删除", "Delete")}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="catalog-edit-form">
        <h4>{modelForm.originalId ? t("编辑模型服务商", "Edit model provider") : t("添加模型服务商", "Add model provider")}</h4>
        <div className="catalog-form">
          <input className="input" value={modelForm.id} disabled={Boolean(modelForm.originalId)} placeholder={t("服务商名称", "Provider name")} onChange={(event) => updateModelForm({ id: event.target.value })} />
          <select className="input" value={modelForm.interfaceType} onChange={(event) => updateModelForm({ interfaceType: event.target.value as ModelInterfaceType })}>
            <option value="openai-chat-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <input value={modelForm.baseURL} placeholder={t("Base URL（留空使用官方地址）", "Base URL (blank for official endpoint)")} onChange={(event) => updateModelForm({ baseURL: event.target.value })} spellCheck={false} />
          <input type="password" value={modelForm.apiKey} placeholder={modelForm.originalId ? t("API Key（留空保留）", "API Key (blank keeps current)") : "API Key"} onChange={(event) => updateModelForm({ apiKey: event.target.value, clearApiKey: false })} autoComplete="off" />
        </div>
        <textarea
          className="extra-body-input"
          value={modelForm.extraBody}
          placeholder={t('自定义请求体（JSON，如 {"temperature": 0.7, "max_tokens": 8192}；留空不附加）', 'Custom request body (JSON, e.g. {"temperature": 0.7, "max_tokens": 8192}; blank to omit)')}
          onChange={(event) => updateModelForm({ extraBody: event.target.value })}
          spellCheck={false}
          rows={3}
        />
        <div className="settings-row">
          <label className="theme-option"><input type="checkbox" checked={modelForm.enabled} onChange={(event) => updateModelForm({ enabled: event.target.checked })} />{t("启用", "Enabled")}</label>
          {modelForm.interfaceType === "anthropic-messages" && <label className="theme-option"><input type="checkbox" checked={modelForm.promptCaching} onChange={(event) => updateModelForm({ promptCaching: event.target.checked })} />{t("提示词缓存", "Prompt caching")}</label>}
          {modelForm.originalId && <label className="theme-option"><input type="checkbox" checked={modelForm.clearApiKey} onChange={(event) => updateModelForm({ clearApiKey: event.target.checked, apiKey: "" })} />{t("清除 API Key", "Clear API key")}</label>}
        </div>
        <div className="dialog-actions"><button className="btn small" disabled={busy} onClick={() => { setModelForm(emptyModelProvider()); setConnectionTest({ status: "idle" }); }}>{t("取消", "Cancel")}</button><button className="btn small" disabled={busy || connectionTest.status === "pending"} onClick={testModelConnection}>{connectionTest.status === "pending" ? t("测试中…", "Testing…") : t("测试连接", "Test connection")}</button><button className="btn small primary" disabled={busy} onClick={saveModelProvider}>{t("保存服务商", "Save provider")}</button></div>
        {connectionTest.status === "ok" && (
          <p className="connection-test-result ok"><Icon name="check" size={12} /> {t("连接成功", "Connection OK")} · {connectionTest.latencyMs} ms{connectionTest.note ? `（${connectionTest.note}）` : ""}</p>
        )}
        {connectionTest.status === "fail" && (
          <p className="connection-test-result fail">{connectionTest.error}</p>
        )}
      </div>
      {error && <p className="settings-error">{error}</p>}
      {confirm.dialogElement}
    </div>
  );
}

/** 「联网服务」页签：联网服务商 CRUD + search/fetch 当前配置选择 + 出站代理子区。 */
export function WebProvidersSection(): ReactElement {
  const { t } = useI18n();
  const profiles = useQuery(providerProfilesQuery);
  const { busy, error, setError, run } = useProfileOps();
  const [webForm, setWebForm] = useState<WebProviderForm>(emptyWebProvider);
  const confirm = useConfirmDialog();

  if (profiles.isPending) return <p className="muted-empty panel-empty">{t("加载服务商配置…", "Loading provider profiles…")}</p>;
  if (profiles.isError || !profiles.data) return <p className="settings-error">{t("无法加载服务商配置。", "Could not load provider profiles.")}</p>;

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
      <h4>{t("联网服务商", "Web providers")}</h4>
      <p className="settings-note">{t("Search 与 Fetch 合并管理；每个配置声明能力，再分别选择当前使用的配置。", "Search and Fetch share one registry. Each profile declares capabilities, then an active profile is selected for each capability.")}</p>
      <div className="settings-grid">
        {(["search", "fetch"] as const).map((capability) => (
          <label key={capability} className="settings-field"><span>{capability === "search" ? t("联网搜索", "Web Search") : t("网页抓取", "Web Fetch")}</span>
            <select className="input" value={profiles.data.activeWeb[capability] ?? ""} onChange={(event) => run(api.selectWebProvider(capability, event.target.value || null))}>
              <option value="">{t("不启用", "Disabled")}</option>
              {profiles.data.webProviders.filter((item) => item.capabilities.includes(capability)).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select>
          </label>
        ))}
      </div>
      {profiles.data.webProviders.length > 0 && (
        <table className="pricing-table catalog-table"><thead><tr><th>{t("名称", "Name")}</th><th>{t("类型", "Type")}</th><th>{t("能力", "Capabilities")}</th><th>API Key</th><th></th></tr></thead>
          <tbody>{profiles.data.webProviders.map((profile) => <tr key={profile.id}><td className="mono">{profile.id}</td><td>{profile.provider}</td><td>{profile.capabilities.join(" + ")}</td><td>{profile.maskedApiKey ?? "—"}</td><td><button className="btn small" disabled={busy} onClick={() => editWeb(profile)}>{t("编辑", "Edit")}</button>{" "}<button className="btn small" disabled={busy} onClick={() => confirm.ask({ title: t("删除联网服务商", "Delete web provider"), body: t(`删除联网服务商「${profile.id}」？`, `Delete web provider “${profile.id}”?`), confirmLabel: t("删除", "Delete"), onConfirm: () => run(api.deleteWebProvider(profile.id)) })}>{t("删除", "Delete")}</button></td></tr>)}</tbody>
        </table>
      )}
      <div className="catalog-edit-form">
        <h4>{webForm.originalId ? t("编辑联网服务商", "Edit web provider") : t("添加联网服务商", "Add web provider")}</h4>
        <div className="catalog-form">
          <input className="input" value={webForm.id} disabled={Boolean(webForm.originalId)} placeholder={t("配置名称", "Profile name")} onChange={(event) => setWebForm((current) => ({ ...current, id: event.target.value }))} />
          <select className="input" value={webForm.provider} onChange={(event) => { const provider = event.target.value as WebProviderType; setWebForm((current) => ({ ...current, provider, capabilities: normalizedCapabilities(provider, current.capabilities) })); }}><option value="brave">Brave</option><option value="tavily">Tavily</option><option value="jina">Jina</option><option value="custom">Custom</option></select>
          <input className="input" type="password" value={webForm.apiKey} placeholder={webForm.originalId ? t("API Key（留空保留）", "API Key (blank keeps current)") : "API Key"} onChange={(event) => setWebForm((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }))} autoComplete="off" />
        </div>
        {webForm.provider === "custom" && <div className="settings-row"><label className="theme-option"><input type="checkbox" checked={webForm.capabilities.includes("search")} onChange={() => toggleWebCapability("search")} />{t("搜索", "Search")}</label><label className="theme-option"><input type="checkbox" checked={webForm.capabilities.includes("fetch")} onChange={() => toggleWebCapability("fetch")} />{t("抓取", "Fetch")}</label></div>}
        <div className="catalog-form">
          {(webForm.provider === "custom" && webForm.capabilities.includes("search")) && <input className="input" value={webForm.searchBaseURL} placeholder={t("Search Base URL", "Search Base URL")} onChange={(event) => setWebForm((current) => ({ ...current, searchBaseURL: event.target.value }))} spellCheck={false} />}
          {(webForm.provider === "custom" && webForm.capabilities.includes("fetch")) && <input className="input" value={webForm.fetchBaseURL} placeholder={t("Fetch Base URL（含 {url}）", "Fetch Base URL (contains {url})")} onChange={(event) => setWebForm((current) => ({ ...current, fetchBaseURL: event.target.value }))} spellCheck={false} />}
        </div>
        {webForm.originalId && <label className="theme-option"><input type="checkbox" checked={webForm.clearApiKey} onChange={(event) => setWebForm((current) => ({ ...current, clearApiKey: event.target.checked, apiKey: "" }))} />{t("清除 API Key", "Clear API key")}</label>}
        <div className="dialog-actions"><button className="btn small" disabled={busy} onClick={() => setWebForm(emptyWebProvider())}>{t("取消", "Cancel")}</button><button className="btn small primary" disabled={busy} onClick={saveWebProvider}>{t("保存服务商", "Save provider")}</button></div>
      </div>
      {error && <p className="settings-error">{error}</p>}
    </div>
    <ProxySection />
    {confirm.dialogElement}
    </>
  );
}
