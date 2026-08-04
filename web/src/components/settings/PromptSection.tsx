import { useEffect, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";

type Scope = "global" | "project";

/** 七个配置面的文本框值（空串 = 该面无覆盖）。 */
interface FaceValues {
  identityOverride: string;
  baseOverride: string;
  customAppend: string;
  subAgentAppend: string;
  initOverride: string;
  compactOverviewOverride: string;
  compactToolcallsOverride: string;
}

const EMPTY_FACES: FaceValues = {
  identityOverride: "",
  baseOverride: "",
  customAppend: "",
  subAgentAppend: "",
  initOverride: "",
  compactOverviewOverride: "",
  compactToolcallsOverride: "",
};

export function PromptSection({ onDirtyChange, sessionCwd }: { onDirtyChange?(dirty: boolean): void; sessionCwd?: string }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // 当前项目 cwd：优先调用方传入；缺省取会话列表首项（与 App 默认选中首个会话一致）。
  // 无会话或会话无 cwd 时项目作用域禁用。
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, enabled: sessionCwd === undefined });
  const projectCwd = sessionCwd ?? sessions.data?.[0]?.cwd;
  const [scope, setScope] = useState<Scope>("global");
  const prompt = useQuery({
    queryKey: ["prompt-override", scope, projectCwd ?? ""],
    queryFn: () => api.promptOverride(scope === "project" ? { scope, cwd: projectCwd! } : { scope: "global" }),
    enabled: scope === "global" || Boolean(projectCwd),
  });
  const [faces, setFaces] = useState<FaceValues>(EMPTY_FACES);
  // 已保存基线：dirty = 文本框偏离基线（保存/恢复成功后基线同步推进）；按作用域+cwd 键控初始化
  const [savedBaseline, setSavedBaseline] = useState<FaceValues>(EMPTY_FACES);
  const [loadedKey, setLoadedKey] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const scopeKey = `${scope}:${projectCwd ?? ""}`;
  useEffect(() => {
    if (!prompt.data || loadedKey === scopeKey) return;
    const loaded: FaceValues = {
      identityOverride: prompt.data.identityOverride ?? "",
      baseOverride: prompt.data.baseOverride ?? "",
      customAppend: prompt.data.customAppend ?? "",
      subAgentAppend: prompt.data.subAgentAppend ?? "",
      initOverride: prompt.data.initOverride ?? "",
      compactOverviewOverride: prompt.data.compactOverviewOverride ?? "",
      compactToolcallsOverride: prompt.data.compactToolcallsOverride ?? "",
    };
    setFaces(loaded);
    setSavedBaseline(loaded);
    setLoadedKey(scopeKey);
  }, [prompt.data, loadedKey, scopeKey]);

  // 向上汇报 dirty，供对话框关闭/切换页签前确认
  useEffect(() => {
    onDirtyChange?.(loadedKey === scopeKey && JSON.stringify(faces) !== JSON.stringify(savedBaseline));
  }, [loadedKey, scopeKey, faces, savedBaseline, onDirtyChange]);

  const save = async (values: FaceValues): Promise<void> => {
    setSaving(true);
    setNotice(undefined);
    setError(undefined);
    const nullable = (value: string): string | null => (value.trim() === "" ? null : value);
    try {
      await api.savePromptOverride({
        scope,
        ...(scope === "project" && projectCwd ? { cwd: projectCwd } : {}),
        identityOverride: nullable(values.identityOverride),
        baseOverride: nullable(values.baseOverride),
        customAppend: nullable(values.customAppend),
        subAgentAppend: nullable(values.subAgentAppend),
        initOverride: nullable(values.initOverride),
        compactOverviewOverride: nullable(values.compactOverviewOverride),
        compactToolcallsOverride: nullable(values.compactToolcallsOverride),
      });
      void queryClient.invalidateQueries({ queryKey: ["prompt-override"] });
      setSavedBaseline(values);
      setFaces(values);
      setNotice(t("已保存", "Saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const setFace = (key: keyof FaceValues) => (event: { target: { value: string } }) =>
    setFaces((previous) => ({ ...previous, [key]: event.target.value }));

  const data = prompt.data;
  return (
    <div className="prompt-section">
      <p className="muted">
        {t(
          "提示词不是安全边界：plan 模式、权限与沙箱由服务独立强制，不受此处覆盖影响。项目级配置保存在 <工作目录>/.owc/ 下，逐面覆盖全局设置。",
          "The prompt is not a security boundary: plan mode, permissions, and sandbox are enforced independently. Project-level settings live in <workspace>/.owc/ and override the global ones face by face.",
        )}
      </p>
      <div className="dialog-actions">
        <button className={scope === "global" ? "btn primary" : "btn"} onClick={() => setScope("global")}>
          {t("全局", "Global")}
        </button>
        <button
          className={scope === "project" ? "btn primary" : "btn"}
          disabled={!projectCwd}
          onClick={() => setScope("project")}
        >
          {projectCwd ? t(`当前项目（${projectCwd}）`, `Current project (${projectCwd})`) : t("当前项目", "Current project")}
        </button>
      </div>
      {!projectCwd ? (
        <p className="muted">{t("没有可用会话（或会话缺少工作目录），项目作用域不可用。", "No session available (or the session has no working directory); the project scope is unavailable.")}</p>
      ) : null}
      {data ? (
        <details className="prompt-builtin">
          <summary>{t(`内置基线（${data.promptVersion}）`, `Built-in baseline (${data.promptVersion})`)}</summary>
          <pre className="prompt-builtin-text">{data.builtinBase}</pre>
        </details>
      ) : null}
      <label className="settings-field">
        <span>{t("身份行", "Identity line")}</span>
        <textarea
          className="input"
          rows={2}
          value={faces.identityOverride}
          placeholder={t("留空则使用默认身份行（env-sim 人格身份优先于此覆盖）", "Leave empty for the default identity line (an env-sim persona identity wins over this override)")}
          onChange={setFace("identityOverride")}
        />
      </label>
      <label className="settings-field">
        <span>{t("基线覆盖", "Baseline override")}</span>
        <textarea
          className="input"
          rows={6}
          value={faces.baseOverride}
          placeholder={t("留空则使用内置基线", "Leave empty to use the built-in baseline")}
          onChange={setFace("baseOverride")}
        />
      </label>
      <label className="settings-field">
        <span>{t("追加指令", "Custom instructions")}</span>
        <textarea
          className="input"
          rows={6}
          value={faces.customAppend}
          placeholder={t("追加到安全约束之后的自定义指令", "Custom instructions appended after safety constraints")}
          onChange={setFace("customAppend")}
        />
      </label>
      <label className="settings-field">
        <span>{t("子代理附加指令", "Sub-agent instructions")}</span>
        <textarea
          className="input"
          rows={4}
          value={faces.subAgentAppend}
          placeholder={t("拼入所有子代理系统提示的附加指令", "Extra instructions appended to every sub-agent system prompt")}
          onChange={setFace("subAgentAppend")}
        />
      </label>
      <label className="settings-field">
        <span>{t("/init 提示词", "/init prompt")}</span>
        <textarea
          className="input"
          rows={4}
          value={faces.initOverride}
          placeholder={t("留空则依次回退到 env-sim 人格提示词与内置 /init 探查提示词", "Leave empty to fall back to the env-sim persona prompt, then the built-in /init exploration prompt")}
          onChange={setFace("initOverride")}
        />
      </label>
      {data?.builtinInitPrompt ? (
        <details className="prompt-builtin">
          <summary>{t("内置 /init 提示词", "Built-in /init prompt")}</summary>
          <pre className="prompt-builtin-text">{data.builtinInitPrompt}</pre>
        </details>
      ) : null}
      <label className="settings-field">
        <span>{t("压缩提示词（概览）", "Compaction prompt (overview)")}</span>
        <textarea
          className="input"
          rows={4}
          value={faces.compactOverviewOverride}
          placeholder={t("留空则使用内置概览压缩系统提示", "Leave empty for the built-in overview compaction system prompt")}
          onChange={setFace("compactOverviewOverride")}
        />
      </label>
      {data?.builtinCompactOverviewPrompt ? (
        <details className="prompt-builtin">
          <summary>{t("内置压缩提示词（概览）", "Built-in compaction prompt (overview)")}</summary>
          <pre className="prompt-builtin-text">{data.builtinCompactOverviewPrompt}</pre>
        </details>
      ) : null}
      <label className="settings-field">
        <span>{t("压缩提示词（工具调用）", "Compaction prompt (tool calls)")}</span>
        <textarea
          className="input"
          rows={4}
          value={faces.compactToolcallsOverride}
          placeholder={t("留空则使用内置工具调用压缩系统提示", "Leave empty for the built-in tool-call compaction system prompt")}
          onChange={setFace("compactToolcallsOverride")}
        />
      </label>
      {data?.builtinCompactToolcallsPrompt ? (
        <details className="prompt-builtin">
          <summary>{t("内置压缩提示词（工具调用）", "Built-in compaction prompt (tool calls)")}</summary>
          <pre className="prompt-builtin-text">{data.builtinCompactToolcallsPrompt}</pre>
        </details>
      ) : null}
      <div className="dialog-actions">
        <button className="btn primary" disabled={saving} onClick={() => void save(faces)}>
          {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
        </button>
        <button className="btn" disabled={saving} onClick={() => void save(EMPTY_FACES)}>
          {t("恢复内置基线", "Restore built-in baseline")}
        </button>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
