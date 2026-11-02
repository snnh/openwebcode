/**
 * Agent 预设子 UI：选择卡片（平铺）、选前预览、删除/还原、复制新建与精简模式工具编辑器。
 * 由设置页「Agent 预设」页签与（精简形态的）扩展配置表单共用。
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { PresetCategory, PresetDetail, PresetInput, PresetToolGroup, PresetToolInfo } from "../../lib/contracts";
import { useI18n } from "../../i18n";
import { presetLabel } from "../../lib/preset-labels";
import { Icon } from "../../components/Icon";
import { useConfirmDialog } from "../../components/ConfirmDialog";

const NO_TOOLS: PresetToolInfo[] = [];
const NO_GROUPS: PresetToolGroup[] = [];

const CATEGORY_LABEL: Record<PresetCategory, { zh: string; en: string }> = {
  minimal: { zh: "精简", en: "Minimal" },
  mimicry: { zh: "拟态", en: "Mimicry" },
  custom: { zh: "自定义", en: "Custom" },
};

/** 预设卡片：点主区域先预览，编辑按钮直接进入编辑器；不改变全局默认。 */
export function PresetCards({ current, previewed, disabled, onPreview, onEdit }: {
  current: string;
  previewed: string;
  disabled?: boolean;
  onPreview(value: string): void;
  onEdit(value: string): void;
}): ReactElement {
  const { t, language } = useI18n();
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets });
  const list = presets.data?.presets ?? [];
  return (
    <div className="preset-grid" data-testid="preset-cards">
      <div className={`preset-card${previewed === "" ? " active" : ""}${current === "" ? " current" : ""}`}>
        <button type="button" className="preset-card-main" aria-pressed={previewed === ""} disabled={disabled} onClick={() => onPreview("")}>
          <span className="preset-card-head">
            <strong>{t("经典", "Classic")}</strong>
          </span>
          {current === "" && <span className="preset-card-status"><span className="preset-badge accent">{t("全局默认", "Global default")}</span></span>}
          <span className="preset-card-desc">{t("基于 PI v1 优化的 OWC 经典提示词框架与全量工具", "OWC's classic prompt framework, tuned from PI v1, with the full tool set.")}</span>
        </button>
      </div>
      {list.map((preset) => {
        const label = presetLabel(preset, language);
        return (
          <div key={preset.id} className={`preset-card${previewed === preset.id ? " active" : ""}${current === preset.id ? " current" : ""}`}>
            <button type="button" className="preset-card-main" aria-pressed={previewed === preset.id} disabled={disabled} onClick={() => onPreview(preset.id)}>
              <span className="preset-card-head">
                <strong>{label.name}</strong>
                <span className="preset-badge">{t(CATEGORY_LABEL[preset.category].zh, CATEGORY_LABEL[preset.category].en)}</span>
              </span>
              {(preset.overridden === true || current === preset.id) && (
                <span className="preset-card-status">
                  {preset.overridden === true && <span className="preset-badge subtle">{t("已自定义", "Customized")}</span>}
                  {current === preset.id && <span className="preset-badge accent">{t("全局默认", "Global default")}</span>}
                </span>
              )}
              <span className="preset-card-desc">{label.description}</span>
            </button>
            <button
              type="button"
              className="icon-btn preset-card-edit"
              aria-label={t(`编辑 ${label.name}`, `Edit ${label.name}`)}
              title={preset.builtin ? t("编辑内置预设（保存为覆盖）", "Edit built-in preset (saved as an override)") : t("编辑此预设", "Edit this preset")}
              disabled={disabled}
              onClick={() => onEdit(preset.id)}
            >
              <Icon name="edit" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 预设「选前预览」：身份行 + 提示词形态 + 工具形态摘要 + 命令拟态。 */
export function PresetPreview({ id }: { id: string }): ReactElement | null {
  const { t } = useI18n();
  const detail = useQuery({ queryKey: ["agent-preset", id], queryFn: () => api.agentPreset(id) });
  if (!detail.data) return null;
  const preset = detail.data;
  const shapedCommands = [
    preset.initPrompt ? "/init" : "",
    preset.compactOverviewPrompt || preset.compactToolcallsPrompt ? "/compact" : "",
  ].filter(Boolean);
  const tools = preset.allowedBuiltIns?.length
    ? t(`工具白名单：${preset.allowedBuiltIns.join("、")}`, `Allowed tools: ${preset.allowedBuiltIns.join(", ")}`)
    : preset.aliases.length > 0
      ? t(`工具形态：${preset.aliases.map((alias) => alias.as).join("、")}`, `Tool shapes: ${preset.aliases.map((alias) => alias.as).join(", ")}`)
      : "";
  return (
    <div className="preset-preview" data-testid="preset-preview">
      {preset.identity && <p className="preset-preview-identity mono">{preset.identity}</p>}
      <p className="settings-note">
        {preset.promptStyle === "minimal" && t("提示词：精简形态", "Prompt: minimal")}
        {tools && `${preset.promptStyle === "minimal" ? " · " : ""}${tools}`}
        {preset.hideBuiltIns.length > 0 && ` · ${t(`隐藏 ${preset.hideBuiltIns.length} 个内置工具`, `${preset.hideBuiltIns.length} built-in tools hidden`)}`}
        {shapedCommands.length > 0 && ` · ${t(`命令拟态：${shapedCommands.join("、")}`, `Command shaping: ${shapedCommands.join(", ")}`)}`}
      </p>
    </div>
  );
}

/** 删除自定义预设；overridden 时为「还原内置」（删除覆盖文件）。确认走统一对话框。 */
export function DeletePresetButton({ id, name, overridden = false, onDeleted }: {
  id: string;
  name: string;
  overridden?: boolean;
  onDeleted(): void;
}): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { ask, dialogElement } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteAgentPreset(id);
      await queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
      await queryClient.invalidateQueries({ queryKey: ["agent-preset", id] });
      await queryClient.invalidateQueries({ queryKey: ["extensions"] });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="btn small danger"
        disabled={busy}
        onClick={() => ask({
          title: overridden ? t("还原内置预设？", "Restore the built-in preset?") : t("删除自定义预设？", "Delete this custom preset?"),
          body: overridden
            ? t(`「${name}」的覆盖文件将被删除，恢复官方内置内容；使用该预设的会话会在下一轮回到内置版本。`, `The override for “${name}” will be removed and the official built-in restored. Sessions using it return to the built-in version on their next turn.`)
            : t(`「${name}」删除后不可恢复；使用该预设的会话将回退到经典模式。`, `“${name}” cannot be restored after deletion. Sessions using it will fall back to classic mode.`),
          confirmLabel: overridden ? t("还原", "Restore") : t("删除", "Delete"),
          onConfirm: () => void remove(),
        })}
      >
        {busy ? t("处理中…", "Working…") : overridden ? t("还原内置预设", "Restore built-in") : t("删除此预设", "Delete preset")}
      </button>
      {error && <p className="error">{error}</p>}
      {dialogElement}
    </>
  );
}

interface PresetDraft {
  id: string;
  name: string;
  description: string;
  identity: string;
  basePrompt: string;
  initPrompt: string;
  compactOverviewPrompt: string;
  compactToolcallsPrompt: string;
  aliasesText: string;
}

const EMPTY_DRAFT: PresetDraft = {
  id: "",
  name: "",
  description: "",
  identity: "",
  basePrompt: "",
  initPrompt: "",
  compactOverviewPrompt: "",
  compactToolcallsPrompt: "",
  aliasesText: "[]",
};

/**
 * 新建/编辑预设：工具名严格校验，精简形态预设走工具编辑器（allowedBuiltIns），
 * 拟态形态预设走 aliases JSON 高级编辑。
 */
export function PresetCreator({ source, onSaved, autoOpen = false, onOpened }: { source?: PresetDetail; onSaved(id: string): void; autoOpen?: boolean; onOpened?(): void }): ReactElement {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PresetDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [allowed, setAllowed] = useState<string[]>([]);
  const [minimalStyle, setMinimalStyle] = useState(false);
  const [externalTools, setExternalTools] = useState(true);

  const catalog = useQuery({ queryKey: ["agent-preset-tools"], queryFn: api.agentPresetTools, enabled: open });
  const tools = catalog.data?.tools ?? NO_TOOLS;
  const groups = catalog.data?.groups ?? NO_GROUPS;
  const toolsByName = useMemo(() => new Map<string, PresetToolInfo>(tools.map((tool) => [tool.name, tool])), [tools]);

  const setDraftField = (key: keyof PresetDraft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [key]: event.target.value }));

  const start = (): void => {
    setDraft(source
      ? {
        id: source.id,
        name: source.name,
        description: source.description,
        identity: source.identity,
        basePrompt: source.basePrompt,
        initPrompt: source.initPrompt ?? "",
        compactOverviewPrompt: source.compactOverviewPrompt ?? "",
        compactToolcallsPrompt: source.compactToolcallsPrompt ?? "",
        aliasesText: JSON.stringify(source.aliases, null, 2),
      }
      : EMPTY_DRAFT);
    setAllowed(source?.allowedBuiltIns ?? []);
    setMinimalStyle(source?.promptStyle === "minimal");
    setExternalTools(source?.externalTools !== false);
    setOpen(true);
  };

  useEffect(() => {
    if (autoOpen) {
      start();
      onOpened?.();
    }
    // autoOpen 只在外部请求打开时变化；start/onOpened 引用变化不应重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);

  const toggleTool = (name: string): void => {
    if (name === "bash") return; // bash 必选
    setAllowed((previous) => previous.includes(name)
      ? previous.filter((item) => item !== name)
      : [...previous, name]);
  };

  const toggleGroup = (group: PresetToolGroup): void => {
    const enabled = group.tools.every((name) => allowed.includes(name) || name === "bash");
    setAllowed((previous) => enabled
      ? previous.filter((name) => !group.tools.includes(name) || name === "bash")
      : [...new Set([...previous, ...group.tools])]);
  };

  const save = async (): Promise<void> => {
    // 与 server preset-store 的 PRESET_ID_PATTERN 保持一致，提前拦截不必等 400
    const id = draft.id.trim();
    const name = draft.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      setError(t("id 只能包含小写字母、数字、'-' 和 '_'，且以字母或数字开头", "ID may only contain lowercase letters, digits, '-' and '_', starting with a letter or digit"));
      return;
    }
    if (!name) {
      setError(t("名称不能为空", "Name is required"));
      return;
    }
    let aliases: unknown;
    try {
      aliases = JSON.parse(draft.aliasesText.trim() === "" ? "[]" : draft.aliasesText);
      if (!Array.isArray(aliases)) throw new Error("not an array");
    } catch {
      setError(t("aliases 不是合法的 JSON 数组", "Aliases must be a valid JSON array"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const body: PresetInput = {
        id,
        name,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        identity: draft.identity,
        basePrompt: draft.basePrompt,
        aliases: aliases as PresetInput["aliases"],
        ...(minimalStyle ? {
          promptStyle: "minimal" as const,
          allowedBuiltIns: [...new Set(["bash", ...allowed])],
          externalTools,
        } : {}),
        ...(draft.initPrompt.trim() ? { initPrompt: draft.initPrompt } : {}),
        ...(draft.compactOverviewPrompt.trim() ? { compactOverviewPrompt: draft.compactOverviewPrompt } : {}),
        ...(draft.compactToolcallsPrompt.trim() ? { compactToolcallsPrompt: draft.compactToolcallsPrompt } : {}),
      };
      const saved = await api.saveAgentPreset(body);
      await queryClient.invalidateQueries({ queryKey: ["agent-presets"] });
      await queryClient.invalidateQueries({ queryKey: ["agent-preset", saved.id] });
      await queryClient.invalidateQueries({ queryKey: ["extensions"] });
      onSaved(saved.id);
      setDraft(EMPTY_DRAFT);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="preset-create-trigger">
        <button className="btn small" onClick={start}>
          {source
            ? (source.builtin ? t("编辑内置预设（保存为覆盖）", "Edit built-in preset (saved as an override)") : t("编辑此预设", "Edit this preset"))
            : t("新建预设", "New preset")}
        </button>
      </div>
    );
  }
  const sourceName = source ? presetLabel(source, language).name : "";
  const saveLabel = !source
    ? t("创建预设", "Create preset")
    : source.builtin
      ? (draft.id.trim() === source.id ? t("保存为覆盖", "Save as override") : t("另存为新预设", "Save as new preset"))
      : t("保存自定义预设", "Save custom preset");
  return (
    <div className="preset-preview" data-testid="preset-creator">
      <h4>{source ? t(`编辑：${sourceName}`, `Edit: ${sourceName}`) : t("新建预设", "New preset")}</h4>
      <label className="settings-field">
        <span>{t("预设 id（小写字母/数字/-/_）", "Preset id (lowercase letters/digits/-/_)")}</span>
        <input className="input" type="text" value={draft.id} spellCheck={false} onChange={setDraftField("id")} placeholder="my-preset" />
      </label>
      <p className="settings-note">{t("id 与内置预设相同时即自定义该内置（只覆盖填写的字段，其余继承内置）；改一个 id 即成全新自定义预设。", "Using a built-in id customizes that built-in preset (only the fields you provide take effect, the rest are inherited); changing the id creates a separate custom preset.")}</p>
      <label className="settings-field">
        <span>{t("显示名称", "Display name")}</span>
        <input className="input" type="text" value={draft.name} onChange={setDraftField("name")} />
      </label>
      <label className="settings-field">
        <span>{t("一句话描述", "Short description")}</span>
        <input className="input" type="text" value={draft.description} onChange={setDraftField("description")} />
      </label>
      <label className="settings-field">
        <span>{t("身份行", "Identity line")}</span>
        <textarea className="input" rows={2} value={draft.identity} onChange={setDraftField("identity")} placeholder="You are ..." />
      </label>
      <label className="settings-field">
        <span>{t("基线提示词", "Base prompt")}</span>
        <textarea className="input" rows={5} value={draft.basePrompt} onChange={setDraftField("basePrompt")} />
      </label>
      <label className="extension-switch">
        <input type="checkbox" checked={minimalStyle} onChange={(event) => setMinimalStyle(event.target.checked)} />
        {t("使用精简提示词形态（按工具白名单裁剪工具集）", "Use the minimal prompt style (tools come from an allowlist)")}
      </label>
      {minimalStyle && (
        <>
          <div className="preset-tool-groups" data-testid="preset-tool-groups">
            {groups.filter((group) => group.tools.length > 0).map((group) => {
              const enabled = group.tools.every((name) => allowed.includes(name) || name === "bash");
              return (
                <label key={group.id} className="extension-switch">
                  <input type="checkbox" checked={enabled} onChange={() => toggleGroup(group)} />
                  {language === "en" ? group.labelEn : group.label}
                </label>
              );
            })}
          </div>
          <div className="preset-tool-list">
            {tools.filter((tool) => !tool.advancedOnly).map((tool) => (
              <label key={tool.name} className="extension-switch" title={tool.description}>
                <input
                  type="checkbox"
                  checked={tool.required === true || allowed.includes(tool.name)}
                  disabled={tool.required === true}
                  onChange={() => toggleTool(tool.name)}
                />
                {language === "en" ? tool.labelEn : tool.label}
                <span className="mono">{toolsByName.get(tool.name)?.name}</span>
              </label>
            ))}
          </div>
          <label className="extension-switch">
            <input type="checkbox" checked={externalTools} onChange={(event) => setExternalTools(event.target.checked)} />
            {t("允许扩展与 MCP 工具进入工具表", "Allow extension and MCP tools")}
          </label>
        </>
      )}
      <label className="settings-field">
        <span>{t("/init 提示词（可选）", "/init prompt (optional)")}</span>
        <textarea className="input" rows={3} value={draft.initPrompt} onChange={setDraftField("initPrompt")} />
      </label>
      <details>
        <summary>{t("高级：压缩提示词与工具形态", "Advanced: compaction prompts and tool shapes")}</summary>
        <label className="settings-field">
          <span>{t("压缩提示词（概览，可选）", "Compaction prompt (overview, optional)")}</span>
          <textarea className="input" rows={3} value={draft.compactOverviewPrompt} onChange={setDraftField("compactOverviewPrompt")} />
        </label>
        <label className="settings-field">
          <span>{t("压缩提示词（工具调用，可选）", "Compaction prompt (tool calls, optional)")}</span>
          <textarea className="input" rows={3} value={draft.compactToolcallsPrompt} onChange={setDraftField("compactToolcallsPrompt")} />
        </label>
        <label className="settings-field">
          <span>{t("aliases（JSON 数组）", "Aliases (JSON array)")}</span>
          <textarea rows={4} className="input mono" value={draft.aliasesText} spellCheck={false} onChange={setDraftField("aliasesText")} />
        </label>
      </details>
      <div className="dialog-actions">
        <button className="btn small primary" disabled={saving} onClick={() => void save()}>
          {saving ? t("保存中…", "Saving…") : saveLabel}
        </button>
        <button className="btn small" disabled={saving} onClick={() => { setOpen(false); setError(undefined); }}>{t("取消", "Cancel")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}