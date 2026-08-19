/**
 * env-sim 扩展的 persona 子 UI：选前预览 / 删除（含还原内置）/ 新建预设。
 * 仅由 ExtensionConfigForm 在 persona 字段处消费；独立成文件让配置表单主逻辑保持聚焦。
 */
import { useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";

/** env-sim 预设「选前预览」：身份行 + 工具形态摘要（别名/隐藏）+ 命令拟态，由详情端点供数。 */
export function PersonaPreview({ id }: { id: string }): ReactElement | null {
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ["env-sim-persona", id],
    queryFn: () => api.envSimPersona(id),
  });
  if (!detail.data) return null;
  const persona = detail.data;
  const shapedCommands = [
    persona.initPrompt ? "/init" : "",
    persona.compactOverviewPrompt || persona.compactToolcallsPrompt ? "/compact" : "",
  ].filter(Boolean);
  return (
    <div className="persona-preview" data-testid="persona-preview">
      <p className="persona-preview-identity mono">{persona.identity}</p>
      <p className="settings-note">
        {persona.aliases.length > 0 && t(
          `工具形态：${persona.aliases.map((alias) => alias.as).join("、")}`,
          `Tool shapes: ${persona.aliases.map((alias) => alias.as).join(", ")}`,
        )}
        {persona.hideBuiltIns.length > 0 && ` · ${t(`隐藏 ${persona.hideBuiltIns.length} 个内置工具`, `${persona.hideBuiltIns.length} built-in tools hidden`)}`}
        {shapedCommands.length > 0 && ` · ${t(`命令拟态：${shapedCommands.join("、")}`, `Command shaping: ${shapedCommands.join(", ")}`)}`}
      </p>
    </div>
  );
}

/** env-sim 自定义预设删除按钮（两段确认）；overridden 时为「还原内置」（删除覆盖文件）。删除成功后失效预设清单并回调。 */
export function DeletePersonaButton({ id, overridden = false, onDeleted }: { id: string; overridden?: boolean; onDeleted(): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteEnvSimPersona(id);
      await queryClient.invalidateQueries({ queryKey: ["env-sim-personas"] });
      await queryClient.invalidateQueries({ queryKey: ["env-sim-persona", id] });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="persona-preview">
      <button
        className={confirming ? "btn small danger" : "btn small"}
        disabled={busy}
        title={overridden ? t("删除覆盖文件，恢复官方内置内容", "Remove the override file and restore the official built-in") : undefined}
        onClick={() => (confirming ? void remove() : setConfirming(true))}
      >
        {busy ? t("处理中…", "Working…") : confirming
          ? (overridden ? t("再次点击确认还原", "Click again to confirm restore") : t("再次点击确认删除", "Click again to confirm"))
          : (overridden ? t("还原内置预设", "Restore built-in preset") : t("删除此自定义预设", "Delete this preset"))}
      </button>
      {confirming && !busy && (
        <button className="btn small" onClick={() => setConfirming(false)}>{t("取消", "Cancel")}</button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface PersonaDraft {
  id: string;
  name: string;
  identity: string;
  basePrompt: string;
  initPrompt: string;
  compactOverviewPrompt: string;
  compactToolcallsPrompt: string;
  aliasesText: string;
}

const EMPTY_DRAFT: PersonaDraft = {
  id: "",
  name: "",
  identity: "",
  basePrompt: "",
  initPrompt: "",
  compactOverviewPrompt: "",
  compactToolcallsPrompt: "",
  aliasesText: "[]",
};

/** env-sim「新建预设」表单：结构化字段 + aliases JSON 高级编辑（同 id 覆盖即编辑）。 */
export function PersonaCreator({ onCreated }: { onCreated(id: string): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PersonaDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const setDraftField = (key: keyof PersonaDraft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [key]: event.target.value }));

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
      const saved = await api.saveEnvSimPersona({
        id,
        name,
        identity: draft.identity,
        basePrompt: draft.basePrompt,
        aliases: aliases as Array<{ from: string; as: string; description?: string }>,
        ...(draft.initPrompt.trim() ? { initPrompt: draft.initPrompt } : {}),
        ...(draft.compactOverviewPrompt.trim() ? { compactOverviewPrompt: draft.compactOverviewPrompt } : {}),
        ...(draft.compactToolcallsPrompt.trim() ? { compactToolcallsPrompt: draft.compactToolcallsPrompt } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["env-sim-personas"] });
      onCreated(saved.id);
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
      <div className="persona-preview">
        <button className="btn small" onClick={() => setOpen(true)}>{t("新建预设", "New preset")}</button>
      </div>
    );
  }
  return (
    <div className="persona-preview" data-testid="persona-creator">
      <label className="settings-field">
        <span>{t("预设 id（小写字母/数字/-/_）", "Preset id (lowercase letters/digits/-/_)")}</span>
        <input className="input" type="text" value={draft.id} spellCheck={false} onChange={setDraftField("id")} placeholder="my-persona" />
      </label>
      <p className="settings-note">{t("id 与内置预设相同时即自定义该内置（只覆盖填写的字段，其余继承内置）。", "Using a built-in id customizes that built-in preset: only the fields you provide take effect, the rest are inherited.")}</p>
      <label className="settings-field">
        <span>{t("显示名称", "Display name")}</span>
        <input className="input" type="text" value={draft.name} onChange={setDraftField("name")} />
      </label>
      <label className="settings-field">
        <span>{t("身份行", "Identity line")}</span>
        <textarea className="input" rows={2} value={draft.identity} onChange={setDraftField("identity")} placeholder="You are ..." />
      </label>
      <label className="settings-field">
        <span>{t("基线提示词", "Base prompt")}</span>
        <textarea className="input" rows={5} value={draft.basePrompt} onChange={setDraftField("basePrompt")} />
      </label>
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
          {saving ? t("保存中…", "Saving…") : t("保存预设", "Save preset")}
        </button>
        <button className="btn small" disabled={saving} onClick={() => { setOpen(false); setError(undefined); }}>{t("取消", "Cancel")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
