/**
 * 统一 diff 视图（0.5.0 Phase 1b）：三种来源同一组件承载，作为编辑器区分栏打开。
 * - 来源：SCM 未提交改动（vs HEAD）、时间线检查点对比、agent 工具改动（write_file/edit_file 工具卡）。
 * - 可视化用 Monaco DiffEditor（monaco-loader 懒加载，加载失败降级为文本 diff，hunk 操作仍可用）。
 * - hunk 级接受/拒绝：拒绝 = 内容写回（把该 hunk 新侧替换回旧侧），统一走 api.writeFile
 *   （server 端 write_file 同一权限链与 plan 只读门禁）；接受 = 保留改动，仅标记。
 *   SCM 已暂存改动在索引中，内容写回无法触及，按只读处理并如实提示；
 *   agent write_file 没有改动前内容，只读展示写入结果；检查点后端只给摘要时按摘要模式展示。
 * - 移动端（summaryOnly）：只读摘要，不加载 Monaco，不提供写操作。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";
import { Icon } from "../Icon";
import { parseUnifiedDiff, reconstructOriginal, revertHunks, type DiffFile } from "../../lib/unified-diff";
import { loadMonaco, type MonacoApi } from "./monaco-loader";
import { monacoLanguageForPath } from "./EditorPane";

/** diff 视图的打开规格：由三个入口（SCM 面板 / 时间线面板 / 工具卡）构造 */
export type DiffSpec =
  | { source: "scm"; path: string; staged: boolean }
  | { source: "checkpoint"; checkpointId: string; label?: string }
  | { source: "agent-edit"; path: string; oldText: string; newText: string }
  | { source: "agent-write"; path: string; content: string };

/** App 侧命令（接受/拒绝 hunk、聚焦）经此动作面触达；注册表不感知 React 状态 */
export interface DiffPaneActions {
  accept?(): void;
  reject?(): void;
  focus?(): void;
}

type DiffMode = "hunks" | "change" | "readonly" | "summary";

interface DiffModel {
  mode: DiffMode;
  /** hunks 模式的解析结果（checkpoint 可能多文件） */
  files: DiffFile[];
  /** 当前文件路径（hunks/change/readonly 模式） */
  path?: string;
  original?: string;
  /** 摘要/只读模式的原始文本 */
  rawText?: string;
  /** 模式说明（如暂存只读、无改动前内容） */
  note?: [string, string];
}

const SOURCE_LABELS: Record<DiffSpec["source"], [string, string]> = {
  scm: ["源代码管理", "Source Control"],
  checkpoint: ["检查点", "Checkpoint"],
  "agent-edit": ["工具改动", "Tool change"],
  "agent-write": ["工具改动", "Tool change"],
};

/** diff 行按前缀着色（与 SCM 面板只读渲染一致） */
function diffLineClass(line: string): string {
  if (line.startsWith("+")) return "diff-line add";
  if (line.startsWith("-")) return "diff-line del";
  if (line.startsWith("\\")) return "diff-line meta";
  return "diff-line";
}

export function DiffPane({ sessionId, spec, readOnly = false, dark, summaryOnly = false, actionsRef, onClose, onNotice }: {
  sessionId: string;
  spec: DiffSpec;
  /** plan 模式：隐藏全部写操作（server 端门禁同样生效） */
  readOnly?: boolean;
  dark: boolean;
  /** 移动端降级：只读摘要，不加载 Monaco、不写回 */
  summaryOnly?: boolean;
  actionsRef?: { current: DiffPaneActions };
  onClose(): void;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<import("monaco-editor").editor.IStandaloneDiffEditor | undefined>(undefined);
  const [monaco, setMonaco] = useState<MonacoApi>();
  const [monacoFailed, setMonacoFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // checkpoint 来源可能含多个文件：用户选择当前查看的文件
  const [selectedPath, setSelectedPath] = useState<string>();
  // 当前（新侧）内容：初始来自磁盘，拒绝 hunk 写回成功后更新
  const [modified, setModified] = useState<string>();
  // hunk 决策：下标 → accepted/rejected
  const [decisions, setDecisions] = useState<Record<number, "accepted" | "rejected">>({});

  const scmDiff = useQuery({
    queryKey: ["scm-diff", sessionId, spec.source === "scm" ? spec.path : "", spec.source === "scm" ? spec.staged : false],
    queryFn: () => api.scmDiff(sessionId, spec.source === "scm" ? { file: spec.path, staged: spec.staged } : {}),
    enabled: spec.source === "scm",
    retry: false,
  });
  const checkpointDiff = useQuery({
    queryKey: ["checkpoint-diff", sessionId, spec.source === "checkpoint" ? spec.checkpointId : ""],
    queryFn: () => api.checkpointDiff(sessionId, spec.source === "checkpoint" ? spec.checkpointId : ""),
    enabled: spec.source === "checkpoint",
    retry: false,
  });

  const checkpointFiles = useMemo(
    () => (spec.source === "checkpoint" && checkpointDiff.data ? parseUnifiedDiff(checkpointDiff.data.diff) : []),
    [spec.source, checkpointDiff.data],
  );

  const activePath = spec.source === "scm" || spec.source === "agent-edit" || spec.source === "agent-write"
    ? spec.path
    : (selectedPath ?? (checkpointFiles[0] ? checkpointFiles[0].newPath || checkpointFiles[0].oldPath : ""));

  const fileContent = useQuery({
    queryKey: ["file-content", sessionId, activePath],
    queryFn: () => api.readFile(sessionId, activePath),
    enabled: Boolean(activePath) && spec.source !== "agent-write",
    retry: false,
  });

  // 磁盘内容到达或路径切换时重置本地状态；agent-write 没有磁盘读取，直接用工具写入内容
  useEffect(() => {
    setModified(spec.source === "agent-write" ? spec.content : fileContent.data?.content);
    setDecisions({});
  }, [fileContent.data?.content, activePath, spec]);
  // 切换打开目标时清空文件选择
  useEffect(() => setSelectedPath(undefined), [spec]);

  const model: DiffModel = useMemo(() => {
    if (spec.source === "scm") {
      const data = scmDiff.data;
      if (!data) return { mode: "summary", files: [] };
      if (data.truncated) {
        return { mode: "summary", files: [], rawText: data.stat, note: ["diff 过大已截断，仅显示统计。", "Diff is too large; only the stat is shown."] };
      }
      const files = parseUnifiedDiff(data.diff ?? "");
      const file = files.find((entry) => (entry.newPath || entry.oldPath) === spec.path) ?? files[0];
      if (!file || file.hunks.length === 0 || fileContent.data === undefined) {
        return { mode: "summary", files: [], rawText: data.diff ?? data.stat };
      }
      if (fileContent.data.truncated) {
        return { mode: "readonly", files: [], path: spec.path, rawText: data.diff, note: ["文件过大，内容被截断，hunk 写回已禁用。", "File is too large; content is truncated and hunk writes are disabled."] };
      }
      if (spec.staged) {
        return { mode: "readonly", files: [file], path: spec.path, rawText: data.diff, note: ["已暂存的改动位于 git 索引中，hunk 接受/拒绝不适用（内容写回无法触及索引）。", "Staged changes live in the git index; hunk accept/reject does not apply (content writes cannot reach the index)."] };
      }
      try {
        const original = reconstructOriginal(fileContent.data.content, file);
        return { mode: "hunks", files: [file], path: spec.path, original };
      } catch {
        return { mode: "summary", files: [], rawText: data.diff, note: ["diff 与当前文件内容不一致（文件可能已被再次修改），仅显示 diff 文本。", "The diff no longer matches the current file (it may have been modified again); showing the diff text only."] };
      }
    }
    if (spec.source === "checkpoint") {
      const data = checkpointDiff.data;
      if (!data) return { mode: "summary", files: [] };
      if (checkpointFiles.length === 0) {
        return { mode: "summary", files: [], rawText: data.diff || "(无差异)", note: ["该快照后端只提供差异摘要。", "This snapshot backend only provides a diff summary."] };
      }
      const file = checkpointFiles.find((entry) => (entry.newPath || entry.oldPath) === activePath) ?? checkpointFiles[0];
      if (!file || fileContent.data === undefined) return { mode: "summary", files: checkpointFiles };
      if (fileContent.data.truncated) {
        return { mode: "readonly", files: checkpointFiles, path: activePath, rawText: data.diff, note: ["文件过大，内容被截断，hunk 写回已禁用。", "File is too large; content is truncated and hunk writes are disabled."] };
      }
      try {
        const original = reconstructOriginal(fileContent.data.content, file);
        return { mode: "hunks", files: checkpointFiles, path: activePath, original };
      } catch {
        return { mode: "summary", files: checkpointFiles, rawText: data.diff, note: ["diff 与当前文件内容不一致（文件可能已被再次修改），仅显示 diff 文本。", "The diff no longer matches the current file (it may have been modified again); showing the diff text only."] };
      }
    }
    if (spec.source === "agent-edit") {
      const content = fileContent.data?.content;
      if (content === undefined) return { mode: "summary", files: [] };
      const at = content.indexOf(spec.newText);
      if (at < 0) {
        return { mode: "summary", files: [], rawText: "", note: ["当前文件中已找不到该工具改动（可能已被后续修改覆盖）。", "The tool change is no longer present in the current file (it may have been overwritten by later edits)."] };
      }
      const original = `${content.slice(0, at)}${spec.oldText}${content.slice(at + spec.newText.length)}`;
      return { mode: "change", files: [], path: spec.path, original };
    }
    // agent-write：没有改动前内容，只读展示工具写入结果
    return { mode: "readonly", files: [], path: spec.path, original: "", rawText: spec.content, note: ["write_file 不保留改动前内容，仅展示写入结果（只读）。", "write_file does not keep the pre-change content; showing the written result (read-only)."] };
  }, [spec, scmDiff.data, checkpointDiff.data, checkpointFiles, activePath, fileContent.data]);

  const activeFile = model.mode === "hunks"
    ? model.files.find((entry) => (entry.newPath || entry.oldPath) === model.path)
    : undefined;
  const pendingHunks = useMemo(
    () => (activeFile ? activeFile.hunks.map((_, index) => index).filter((index) => !(index in decisions)) : []),
    [activeFile, decisions],
  );
  // 写操作总开关：plan 只读 / 移动端摘要 / 非交互模式 都不提供
  const canWrite = !readOnly && !summaryOnly && (model.mode === "hunks" || model.mode === "change");

  // Monaco 懒加载：移动端摘要不加载；失败仅降级可视化为文本 diff
  useEffect(() => {
    if (summaryOnly) return;
    let alive = true;
    loadMonaco().then(
      (api2) => { if (alive) setMonaco(api2); },
      () => { if (alive) setMonacoFailed(true); },
    );
    return () => { alive = false; };
  }, [summaryOnly]);

  // 创建/更新 DiffEditor：original/modified 变化时重建（拒绝 hunk 后内容整体更新）
  useEffect(() => {
    if (!monaco || summaryOnly || model.original === undefined || modified === undefined || !hostRef.current) return;
    if (model.mode !== "hunks" && model.mode !== "change" && model.mode !== "readonly") return;
    monaco.editor.setTheme(dark ? "vs-dark" : "vs");
    const language = monacoLanguageForPath(monaco, model.path ?? "");
    const originalModel = monaco.editor.createModel(model.original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    diffEditorRef.current = editor;
    editor.addCommand(monaco.KeyCode.Escape, () => onClose());
    return () => {
      diffEditorRef.current = undefined;
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
    // onClose 变化不重建编辑器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, summaryOnly, model.original, model.mode, model.path, modified, dark]);

  // 主题切换实时生效
  useEffect(() => {
    monaco?.editor.setTheme(dark ? "vs-dark" : "vs");
  }, [monaco, dark]);

  const acceptHunk = useCallback((index: number): void => {
    // 接受 = 保留改动：磁盘内容本来就包含该 hunk，只标记
    setDecisions((previous) => ({ ...previous, [index]: "accepted" }));
  }, []);

  const rejectHunk = useCallback((index: number): void => {
    if (busy || !activeFile || !model.path || modified === undefined) return;
    let next: string;
    try {
      next = revertHunks(modified, activeFile, [index]);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "hunk 与当前文件内容不匹配", "error");
      return;
    }
    setBusy(true);
    api.writeFile(sessionId, model.path, next).then(
      () => {
        setModified(next);
        setDecisions((previous) => ({ ...previous, [index]: "rejected" }));
        onNotice(t("已拒绝该 hunk 并写回文件", "Hunk rejected and written back"));
      },
      (error: unknown) => onNotice(error instanceof Error ? error.message : t("写回失败", "Write-back failed"), "error"),
    ).finally(() => setBusy(false));
  }, [activeFile, busy, model.path, modified, onNotice, sessionId, t]);

  // change 模式（agent edit_file）：接受 = 保留（标记完成）；拒绝 = 写回改动前内容
  const [changeResolved, setChangeResolved] = useState<"accepted" | "rejected">();
  useEffect(() => setChangeResolved(undefined), [spec]);
  const rejectChange = useCallback((): void => {
    if (busy || model.mode !== "change" || !model.path || model.original === undefined) return;
    setBusy(true);
    api.writeFile(sessionId, model.path, model.original).then(
      () => {
        setModified(model.original);
        setChangeResolved("rejected");
        onNotice(t("已还原该工具改动", "Tool change reverted"));
      },
      (error: unknown) => onNotice(error instanceof Error ? error.message : t("写回失败", "Write-back failed"), "error"),
    ).finally(() => setBusy(false));
  }, [busy, model.mode, model.path, model.original, onNotice, sessionId, t]);

  // App 命令动作面：接受/拒绝当前（首个待处理）hunk、聚焦
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current.accept = () => {
      if (!canWrite) return;
      if (model.mode === "change") setChangeResolved("accepted");
      else if (pendingHunks.length > 0) acceptHunk(pendingHunks[0]!);
    };
    actionsRef.current.reject = () => {
      if (!canWrite) return;
      if (model.mode === "change") rejectChange();
      else if (pendingHunks.length > 0) rejectHunk(pendingHunks[0]!);
    };
    actionsRef.current.focus = () => diffEditorRef.current?.focus();
    return () => {
      actionsRef.current.accept = undefined;
      actionsRef.current.reject = undefined;
      actionsRef.current.focus = undefined;
    };
  }, [actionsRef, canWrite, model.mode, pendingHunks, acceptHunk, rejectHunk, rejectChange]);

  // Esc 回到对话（capture 兜底 Monaco 之外的焦点；Monaco 内由 addCommand 处理）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Node && hostRef.current?.contains(event.target)) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const loading = (spec.source === "scm" && scmDiff.isPending) || (spec.source === "checkpoint" && checkpointDiff.isPending)
    || (spec.source !== "agent-write" && Boolean(activePath) && fileContent.isPending);
  const loadError = (spec.source === "scm" && scmDiff.error) || (spec.source === "checkpoint" && checkpointDiff.error)
    || (spec.source !== "agent-write" && fileContent.error);
  const sourceLabel = SOURCE_LABELS[spec.source];
  const title = model.path ?? (spec.source === "checkpoint" ? (spec.label ?? spec.checkpointId) : "");

  const header = (
    <header className="editor-pane-header">
      <nav className="editor-breadcrumb" aria-label={t("diff 来源", "Diff source")}>
        <span className="editor-breadcrumb-item">{t(...sourceLabel)}</span>
        <span className="editor-breadcrumb-sep">›</span>
        <span className="editor-breadcrumb-item"><strong>{title}</strong></span>
        {spec.source === "scm" && spec.staged && <span className="editor-breadcrumb-item">{t("（已暂存）", " (staged)")}</span>}
      </nav>
      <div className="editor-pane-actions">
        {checkpointFiles.length > 1 && (
          <select
            className="diff-file-select"
            aria-label={t("选择文件", "Select file")}
            value={activePath}
            onChange={(event) => setSelectedPath(event.target.value)}
          >
            {checkpointFiles.map((entry) => {
              const path = entry.newPath || entry.oldPath;
              return <option key={path} value={path}>{path}</option>;
            })}
          </select>
        )}
        <button className="icon-btn" aria-label={t("回到对话（Esc）", "Back to conversation (Esc)")} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </header>
  );

  // 移动端降级：只读摘要（不加载 Monaco、不写回）
  if (summaryOnly) {
    return (
      <section className="diff-pane diff-pane-summary" aria-label={t(`变更摘要：${title}`, `Change summary: ${title}`)}>
        {header}
        <div className="editor-pane-body diff-summary-body">
          {loading && <p className="wb-overlay-hint">{t("加载中…", "Loading…")}</p>}
          {model.note && <p className="editor-pane-note">{t(...model.note)}</p>}
          {model.mode === "hunks" || model.mode === "change" ? (
            <p className="wb-overlay-hint">
              {activeFile
                ? t(`${activeFile.hunks.length} 个 hunk；在桌面端打开可逐个接受/拒绝。`, `${activeFile.hunks.length} hunk(s); open on desktop to accept or reject them individually.`)
                : t("存在改动；在桌面端打开可查看并处理。", "Changes detected; open on desktop to review and resolve.")}
            </p>
          ) : (
            <pre className="diff-lines">{model.rawText ?? ""}</pre>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="editor-pane diff-pane" aria-label={t(`diff：${title}`, `Diff: ${title}`)}>
      {header}
      {readOnly && (
        <p className="editor-pane-note">{t("Plan 模式为只读：hunk 接受/拒绝已锁定，切换到 build 模式后可写回。", "Plan mode is read-only: hunk accept/reject is locked. Switch to build mode to write back.")}</p>
      )}
      {model.note && <p className="editor-pane-note">{t(...model.note)}</p>}
      {model.mode === "hunks" && activeFile && (
        <div className="diff-hunk-bar" role="list" aria-label={t("hunk 列表", "Hunk list")}>
          {activeFile.hunks.map((hunk, index) => {
            const status: "pending" | "accepted" | "rejected" = decisions[index] ?? "pending";
            return (
              <div key={index} className={`diff-hunk${index === pendingHunks[0] ? " current" : ""}`} data-status={status} role="listitem">
                <code className="diff-hunk-header" title={hunk.header}>{hunk.header}</code>
                <span className="diff-hunk-status">
                  {status === "accepted" ? t("已接受", "Accepted") : status === "rejected" ? t("已拒绝", "Rejected") : t("待处理", "Pending")}
                </span>
                {canWrite && !(index in decisions) && (
                  <>
                    <button className="btn small" disabled={busy} onClick={() => acceptHunk(index)} aria-keyshortcuts="Control+Alt+a Meta+Alt+a">
                      {t("接受", "Accept")}
                    </button>
                    <button className="btn small danger-outline" disabled={busy} onClick={() => rejectHunk(index)} aria-keyshortcuts="Control+Alt+r Meta+Alt+r">
                      {t("拒绝", "Reject")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {pendingHunks.length === 0 && (
            <p className="diff-all-done">{t("全部 hunk 已处理。", "All hunks resolved.")}</p>
          )}
        </div>
      )}
      {model.mode === "change" && canWrite && !changeResolved && (
        <div className="diff-hunk-bar">
          <div className="diff-hunk" data-status="pending">
            <span className="diff-hunk-status">{t("接受 = 保留改动；拒绝 = 还原为该改动前的内容", "Accept = keep the change; Reject = restore the pre-change content")}</span>
            <button className="btn small" disabled={busy} onClick={() => setChangeResolved("accepted")}>{t("接受改动", "Accept change")}</button>
            <button className="btn small danger-outline" disabled={busy} onClick={rejectChange}>{t("拒绝改动", "Reject change")}</button>
          </div>
        </div>
      )}
      {changeResolved && <p className="editor-pane-note">{changeResolved === "accepted" ? t("已接受该工具改动。", "Tool change accepted.") : t("已拒绝并还原该工具改动。", "Tool change rejected and reverted.")}</p>}
      <div className="editor-pane-body">
        {loading && <p className="wb-overlay-hint">{t("加载中…", "Loading…")}</p>}
        {loadError instanceof Error && (
          <p className="wb-overlay-hint">{t(`无法加载 diff：${loadError.message}`, `Could not load the diff: ${loadError.message}`)}</p>
        )}
        {!loading && (monacoFailed || model.mode === "summary" || model.mode === "readonly" || model.original === undefined || modified === undefined) && model.rawText !== undefined && (
          <pre className="diff-lines diff-fallback" data-testid="diff-fallback">
            {model.rawText.split("\n").map((line, index) => <div key={index} className={diffLineClass(line)}>{line || " "}</div>)}
          </pre>
        )}
        {!loading && monacoFailed && model.mode !== "summary" && model.mode !== "readonly" && model.original !== undefined && modified !== undefined && (
          <pre className="diff-lines diff-fallback" data-testid="diff-fallback-content">
            {t("（ Monaco 加载失败，显示新侧内容；hunk 操作仍可用 ）", "(Monaco failed to load; showing the new side. Hunk actions still work.)")}
            {"\n"}{modified}
          </pre>
        )}
        {!loading && !monacoFailed && model.original !== undefined && modified !== undefined && <div ref={hostRef} className="editor-host" data-testid="monaco-diff-host" />}
      </div>
    </section>
  );
}
