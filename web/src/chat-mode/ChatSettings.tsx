// 对话设置面板：助手选择、provider/model、能力模型（vision/image_gen）、工具开关、生成参数。
// 会话字段经 PATCH /api/chat/sessions/:id 保存（服务端白名单字段）；
// 能力模型是全局配置，经 PUT /api/chat/config 整体替换保存（先 GET 合并再 PUT）。
import { useEffect, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { ui } from "../app/ui-store";
import { api, ApiError } from "../lib/api";
import type { ChatAssistant, ChatConfig, ChatModelEntry, ChatSessionMeta } from "./types";

interface ToolCategory {
  key: string;
  label: string;
  tools: string[];
  /** 该分类整体受 sandboxEnabled 总开关约束。 */
  sandbox?: boolean;
}

export function ChatSettings({ sessionId, onClose, onSaved }: {
  sessionId: string;
  onClose(): void;
  onSaved?(): void;
}): ReactElement {
  const { t } = useI18n();
  const [meta, setMeta] = useState<ChatSessionMeta | null>(null);
  const [assistants, setAssistants] = useState<ChatAssistant[]>([]);
  const [models, setModels] = useState<ChatModelEntry[]>([]);
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);
  const [saving, setSaving] = useState(false);
  // 文本字段受控草稿：失焦/确认才 PATCH，避免逐键打爆接口
  const [temperatureDraft, setTemperatureDraft] = useState("");

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function applyMeta(next: ChatSessionMeta): void {
    setMeta(next);
    setTemperatureDraft(next.temperature === undefined ? "" : String(next.temperature));
  }

  async function loadData(): Promise<void> {
    // 各端点独立容错：某个拉取失败不影响其他
    await Promise.all([
      api.chatSession(sessionId).then(applyMeta).catch(() => undefined),
      api.chatAssistants().then(setAssistants).catch(() => undefined),
      api.chatModels().then(setModels).catch(() => undefined),
      api.chatConfig().then(setChatConfig).catch(() => undefined),
    ]);
  }

  async function save(patch: Partial<ChatSessionMeta>): Promise<void> {
    setSaving(true);
    try {
      const next = await api.chatPatch(sessionId, patch);
      applyMeta(next);
      onSaved?.();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          ui.notify(t("需要访问令牌才能保存设置", "Access token required to save settings"), "error");
        } else {
          ui.notify(t("保存失败，请检查输入", "Save failed; please check your input"), "error");
        }
        await loadData();
      } else {
        ui.notify(t("保存失败", "Save failed"), "error");
      }
    }
    setSaving(false);
  }

  /** 能力模型保存：chat.json 是整体替换语义，先基于已加载配置合并再 PUT。 */
  async function saveConfig(field: "visionModel" | "imageGenModel", value: { provider: string; model: string } | undefined): Promise<void> {
    if (!chatConfig) return;
    setSaving(true);
    const next: Record<string, unknown> = { ...chatConfig };
    if (value) next[field] = value;
    else delete next[field];
    try {
      const updated = await api.chatSaveConfig(next);
      setChatConfig(updated);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          ui.notify(t("需要访问令牌才能保存设置", "Access token required to save settings"), "error");
        } else {
          ui.notify(t("保存失败，请检查输入", "Save failed; please check your input"), "error");
        }
      } else {
        ui.notify(t("保存失败", "Save failed"), "error");
      }
    }
    setSaving(false);
  }

  /** 文本草稿失焦保存：值未变化时不发请求。 */
  function commitDraft(field: "temperature"): void {
    if (!meta) return;
    if (field === "temperature") {
      const current = meta.temperature === undefined ? "" : String(meta.temperature);
      if (temperatureDraft === current) return;
      if (!temperatureDraft.trim()) void save({ temperature: undefined });
      else {
        const value = Number(temperatureDraft);
        if (Number.isNaN(value)) {
          ui.notify(t("Temperature 必须是数字", "Temperature must be a number"), "error");
          setTemperatureDraft(current);
          return;
        }
        void save({ temperature: value });
      }
    }
  }

  if (!meta) {
    return <div className="chat-settings-panel"><p>{t("加载中…", "Loading…")}</p></div>;
  }

  const toolCategories: ToolCategory[] = [
    { key: "utility", label: t("实用工具", "Utilities"), tools: ["time", "calculate"] },
    { key: "web", label: t("网络工具", "Web"), tools: ["web_search", "web_fetch"] },
    { key: "media", label: t("媒体工具", "Media"), tools: ["image_gen", "vision"] },
    { key: "sandbox", label: t("沙盒工具", "Sandbox"), tools: ["python", "read_file", "write_file", "show"], sandbox: true },
  ];

  const enabledTools = meta.enabledTools ?? [];

  // 能力模型候选：按 /api/chat/models 的能力声明过滤（modalities 含 "image" = vision 候选；imageOutput = image_gen 候选）
  const visionCandidates = models.flatMap((entry) =>
    entry.models.filter((m) => m.modalities.includes("image")).map((m) => ({ provider: entry.provider, model: m.id })));
  const imageGenCandidates = models.flatMap((entry) =>
    entry.models.filter((m) => m.imageOutput).map((m) => ({ provider: entry.provider, model: m.id })));

  // 当前 provider 对应的模型候选条目（模型分区的级联下拉复用）
  const currentProviderEntry = models.find((entry) => entry.provider === meta.provider);
  // 主模型自带对应能力时工具冗余：仅前端隐藏开关（server 不过滤 enabledTools）
  const mainModel = currentProviderEntry?.models.find((m) => m.id === meta.model);
  const hiddenTools = new Set<string>();
  if (mainModel?.modalities.includes("image")) hiddenTools.add("vision");
  if (mainModel?.imageOutput === true) hiddenTools.add("image_gen");

  /** 下拉值编码为 provider/model（provider id 不含 "/"，按首个 "/" 切分）。 */
  function capabilityValue(selection: { provider: string; model: string } | undefined): string {
    return selection ? `${selection.provider}/${selection.model}` : "";
  }

  function handleCapabilityChange(field: "visionModel" | "imageGenModel", raw: string): void {
    if (!raw) {
      void saveConfig(field, undefined);
      return;
    }
    const slash = raw.indexOf("/");
    void saveConfig(field, { provider: raw.slice(0, slash), model: raw.slice(slash + 1) });
  }

  return (
    <div className="chat-settings-panel">
      <div className="chat-settings-section">
        <h4>{t("助手", "Assistant")}</h4>
        <select
          className="input"
          value={meta.assistantId ?? ""}
          onChange={(event) => void save({ assistantId: event.target.value || undefined })}
        >
          <option value="">{t("不使用助手", "No assistant")}</option>
          {assistants.map((assistant) => (
            <option key={assistant.id} value={assistant.id}>{assistant.name}</option>
          ))}
        </select>
      </div>

      <div className="chat-settings-section">
        <h4>{t("模型", "Model")}</h4>
        <div className="chat-settings-row">
          <label>{t("服务商", "Provider")}</label>
          <select
            className="input"
            value={meta.provider}
            onChange={(event) => {
              const provider = event.target.value;
              // 切换 provider 时把 model 重置为「新 provider」的第一个候选，
              // 避免旧 model 悬挂在已切走的 provider 上；一次 PATCH 同时提交两者
              const first = models.find((entry) => entry.provider === provider)?.models[0]?.id ?? "";
              void save({ provider, ...(first ? { model: first } : {}) });
            }}
          >
            {/* 当前 provider 不在候选（已禁用/自定义）时补占位 option，防值丢失 */}
            {!models.some((entry) => entry.provider === meta.provider) && (
              <option value={meta.provider}>{meta.provider}</option>
            )}
            {models.map((entry) => (
              <option key={entry.provider} value={entry.provider}>{entry.provider}</option>
            ))}
          </select>
        </div>
        <div className="chat-settings-row">
          <label>{t("模型", "Model")}</label>
          <select
            className="input"
            value={meta.model}
            onChange={(event) => void save({ model: event.target.value })}
          >
            {/* 当前 model 不在当前 provider 候选中时补占位 option，防值丢失 */}
            {currentProviderEntry && !currentProviderEntry.models.some((m) => m.id === meta.model) && (
              <option value={meta.model}>{meta.model}</option>
            )}
            {currentProviderEntry?.models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="chat-settings-section">
        <h4>{t("能力模型", "Capability Models")}</h4>
        <div className="chat-settings-row">
          <label>{t("vision 模型（图像理解）", "Vision model (image understanding)")}</label>
          <select
            className="input"
            aria-label={t("vision 模型（图像理解）", "Vision model (image understanding)")}
            value={capabilityValue(chatConfig?.visionModel)}
            onChange={(event) => handleCapabilityChange("visionModel", event.target.value)}
          >
            <option value="">{t("未配置", "Not configured")}</option>
            {visionCandidates.map((candidate) => (
              <option key={`${candidate.provider}/${candidate.model}`} value={`${candidate.provider}/${candidate.model}`}>
                {candidate.provider}/{candidate.model}
              </option>
            ))}
          </select>
        </div>
        <div className="chat-settings-row">
          <label>{t("image_gen 模型（生图）", "image_gen model (image generation)")}</label>
          <select
            className="input"
            aria-label={t("image_gen 模型（生图）", "image_gen model (image generation)")}
            value={capabilityValue(chatConfig?.imageGenModel)}
            onChange={(event) => handleCapabilityChange("imageGenModel", event.target.value)}
          >
            <option value="">{t("未配置", "Not configured")}</option>
            {imageGenCandidates.map((candidate) => (
              <option key={`${candidate.provider}/${candidate.model}`} value={`${candidate.provider}/${candidate.model}`}>
                {candidate.provider}/{candidate.model}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chat-settings-section">
        <h4>{t("工具", "Tools")}</h4>
        <div className="chat-settings-row">
          <label>{t("启用沙盒", "Enable sandbox")}</label>
          <Toggle
            checked={meta.sandboxEnabled ?? false}
            label={t("启用沙盒", "Enable sandbox")}
            onChange={(checked) => void save({ sandboxEnabled: checked })}
          />
        </div>
        {toolCategories.map((category) => (
          <div key={category.key} className="chat-settings-section">
            <h4>{category.label}</h4>
            {category.tools.map((tool) => {
              if (hiddenTools.has(tool)) return null;
              const disabled = category.sandbox === true && !(meta.sandboxEnabled ?? false);
              const enabled = enabledTools.includes(tool);
              const capabilityMissing = chatConfig !== null
                && ((tool === "vision" && !chatConfig.visionModel) || (tool === "image_gen" && !chatConfig.imageGenModel));
              return (
                <div key={tool} className="chat-settings-row" style={{ opacity: disabled ? 0.5 : 1 }}>
                  <label>{tool}</label>
                  {capabilityMissing && (
                    <span className="pill amber">{t("未配置能力模型", "Capability model not configured")}</span>
                  )}
                  <Toggle
                    checked={enabled}
                    disabled={disabled}
                    label={tool}
                    onChange={(checked) => {
                      void save({
                        enabledTools: checked
                          ? [...enabledTools, tool]
                          : enabledTools.filter((name) => name !== tool),
                      });
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="chat-settings-section">
        <h4>{t("生成参数", "Generation")}</h4>
        <div className="chat-settings-row">
          <label>Temperature</label>
          <input
            className="input"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={temperatureDraft}
            placeholder={t("默认", "Default")}
            onChange={(event) => setTemperatureDraft(event.target.value)}
            onBlur={() => commitDraft("temperature")}
          />
        </div>
      </div>

      <div className="chat-settings-row">
        {saving && <span className="muted">{t("保存中…", "Saving…")}</span>}
        <button className="btn small" onClick={onClose}>{t("关闭", "Close")}</button>
      </div>
    </div>
  );
}

/** 开关基元（chat-mode.css 的 .toggle 按钮样式）。 */
function Toggle({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`toggle${checked ? " on" : ""}`}
      disabled={disabled}
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    />
  );
}
