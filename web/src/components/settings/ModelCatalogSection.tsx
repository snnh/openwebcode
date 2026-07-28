import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ModelProfile } from "../../lib/contracts";
import { ModelCapabilityBadges } from "../ModelCapabilityBadges";
import { useI18n } from "../../i18n";

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
