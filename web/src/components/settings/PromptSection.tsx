import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";

export function PromptSection({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const prompt = useQuery({ queryKey: ["prompt-override"], queryFn: () => api.promptOverride() });
  const [baseOverride, setBaseOverride] = useState("");
  const [customAppend, setCustomAppend] = useState("");
  const [initialized, setInitialized] = useState(false);
  // 已保存基线：dirty = 文本框偏离基线（保存/恢复成功后基线同步推进）
  const [savedBaseline, setSavedBaseline] = useState({ baseOverride: "", customAppend: "" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!prompt.data || initialized) return;
    const loaded = { baseOverride: prompt.data.baseOverride ?? "", customAppend: prompt.data.customAppend ?? "" };
    setBaseOverride(loaded.baseOverride);
    setCustomAppend(loaded.customAppend);
    setSavedBaseline(loaded);
    setInitialized(true);
  }, [prompt.data, initialized]);

  // 向上汇报 dirty，供对话框关闭/切换页签前确认
  useEffect(() => {
    onDirtyChange?.(initialized && (baseOverride !== savedBaseline.baseOverride || customAppend !== savedBaseline.customAppend));
  }, [initialized, baseOverride, customAppend, savedBaseline, onDirtyChange]);

  const save = async (body: { baseOverride?: string | null; customAppend?: string | null }): Promise<void> => {
    setSaving(true);
    setNotice(undefined);
    setError(undefined);
    try {
      await api.savePromptOverride(body);
      void queryClient.invalidateQueries({ queryKey: ["prompt-override"] });
      setSavedBaseline({ baseOverride: body.baseOverride ?? "", customAppend: body.customAppend ?? "" });
      setBaseOverride(body.baseOverride ?? "");
      setCustomAppend(body.customAppend ?? "");
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
