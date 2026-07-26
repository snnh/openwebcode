/**
 * Monaco 编辑器分栏（0.5.0 Phase 1a）：对话的辅助视图，查看/编辑/保存工作区文件。
 * - Monaco 经 monaco-loader 懒加载（独立 chunk）；加载失败降级为只读代码视图，不阻塞会话。
 * - 保存走 server 端 PUT /files/content（write_file 同一权限链与 plan 只读门禁），不绕过审批。
 * - 面包屑：路径段 + 光标处符号（符号数据来自 0.4.0 索引 /api/workspaces/symbols?file=）。
 * - 小地图默认关；plan 模式只读；文件被截断（过大）时禁止保存，防止部分内容覆盖原文件。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useI18n } from "../../i18n";
import { CodeView } from "./CodeView";
import { Icon } from "../Icon";
import { langFromPath } from "../CodeOverlay";
import { loadMonaco, type MonacoApi } from "./monaco-loader";

/** App 侧命令（保存/聚焦）经此动作面触达编辑器；注册表不感知 React 状态 */
export interface EditorPaneActions {
  save?(): void;
  focus?(): void;
}

/** 按扩展名从 Monaco 已注册语言里匹配；不支持回退 plaintext */
export function monacoLanguageForPath(monaco: MonacoApi, path: string): string {
  const lower = path.toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((extension) => lower.endsWith(extension))) return language.id;
  }
  return "plaintext";
}

/** 面包屑符号：取包含光标行的最内层符号（范围最小者） */
export function symbolAtLine(symbols: Array<{ name: string; startLine: number; endLine: number }>, line: number): { name: string; startLine: number } | undefined {
  let best: { name: string; startLine: number; endLine: number } | undefined;
  for (const symbol of symbols) {
    if (symbol.startLine > line || symbol.endLine < line) continue;
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

export function EditorPane({ sessionId, path, line, column, readOnly = false, dark, actionsRef, onClose, onNotice }: {
  sessionId: string;
  path: string;
  /** 1-based 初始跳转位置（Problems 升级入口） */
  line?: number;
  column?: number;
  /** plan 模式：只读（server 端门禁同样生效，这里做 UI 层提示与按键屏蔽） */
  readOnly?: boolean;
  dark: boolean;
  actionsRef?: { current: EditorPaneActions };
  onClose(): void;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | undefined>(undefined);
  const savedValueRef = useRef<string | undefined>(undefined);
  const revisionRef = useRef<string | undefined>(undefined);
  const [monaco, setMonaco] = useState<MonacoApi>();
  const [monacoFailed, setMonacoFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursorLine, setCursorLine] = useState(line ?? 1);

  const content = useQuery({
    queryKey: ["file-content", sessionId, path],
    queryFn: () => api.readFile(sessionId, path),
    retry: false,
  });
  // 符号面包屑数据源（0.4.0 索引）；索引未启用/未建时 501/409 按无符号降级
  const symbols = useQuery({
    queryKey: ["file-symbols", sessionId, path],
    queryFn: () => api.workspaceFileSymbols(sessionId, path),
    retry: false,
  });

  // Monaco 懒加载：失败仅降级本视图为只读代码视图
  useEffect(() => {
    let alive = true;
    loadMonaco().then(
      (api2) => { if (alive) setMonaco(api2); },
      () => { if (alive) setMonacoFailed(true); },
    );
    return () => { alive = false; };
  }, []);

  const code = content.data?.content;
  // 文件过大被截断时禁止保存：部分内容写回会覆盖原文件
  const saveBlocked = readOnly || Boolean(content.data?.truncated);

  // 创建/销毁编辑器实例（每个 path 一个 model）
  useEffect(() => {
    if (!monaco || code === undefined || !hostRef.current) return;
    monaco.editor.setTheme(dark ? "vs-dark" : "vs");
    const model = monaco.editor.createModel(code, monacoLanguageForPath(monaco, path));
    savedValueRef.current = code;
    revisionRef.current = content.data?.revision;
    const editor = monaco.editor.create(hostRef.current, {
      model,
      readOnly: saveBlocked,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontSize: 13,
    });
    editorRef.current = editor;
    if (line && line >= 1) {
      editor.setPosition({ lineNumber: line, column: column ?? 1 });
      editor.revealLineInCenter(line);
    }
    const listeners = [
      editor.onDidChangeModelContent(() => setDirty(editor.getValue() !== savedValueRef.current)),
      editor.onDidChangeCursorPosition((event) => setCursorLine(event.position.lineNumber)),
    ];
    // Monaco 内 Esc 即回到对话（全局 capture 监听兜底见下方 effect）；随 editor.dispose 一并释放
    editor.addCommand(monaco.KeyCode.Escape, () => onClose());
    setDirty(false);
    return () => {
      for (const listener of listeners) listener.dispose();
      editorRef.current = undefined;
      editor.dispose();
      model.dispose();
    };
    // onClose/saveBlocked 变化不重建编辑器（避免丢失未保存内容）；readOnly 经下方 setOptions 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, code, path]);

  // plan/截断态变化时同步 readOnly，不重建编辑器
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: saveBlocked });
  }, [saveBlocked]);

  // 主题切换实时生效
  useEffect(() => {
    monaco?.editor.setTheme(dark ? "vs-dark" : "vs");
  }, [monaco, dark]);

  const save = useCallback((): void => {
    const editor = editorRef.current;
    if (!editor || saving || saveBlocked) return;
    const expectedRevision = revisionRef.current;
    if (!expectedRevision) return;
    setSaving(true);
    api.writeFile(sessionId, path, editor.getValue(), expectedRevision).then(
      (result) => {
        savedValueRef.current = editor.getValue();
        revisionRef.current = result.revision;
        setDirty(false);
        onNotice(t(`已保存 ${path}`, `Saved ${path}`));
      },
      (error: unknown) => onNotice(error instanceof Error ? error.message : t("保存失败", "Save failed"), "error"),
    ).finally(() => setSaving(false));
  }, [saving, saveBlocked, sessionId, path, onNotice, t]);

  // App 命令动作面：mod+s 保存 / 分栏焦点切换
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current.save = save;
    actionsRef.current.focus = () => editorRef.current?.focus();
    return () => {
      actionsRef.current.save = undefined;
      actionsRef.current.focus = undefined;
    };
  }, [actionsRef, save]);

  // 关闭前确认未保存修改
  const requestClose = useCallback((): void => {
    if (dirty && !window.confirm(t("有未保存的修改，确定关闭编辑器？", "You have unsaved changes. Close the editor anyway?"))) return;
    onClose();
  }, [dirty, onClose, t]);

  // Esc 回到对话（capture 兜底 Monaco 之外的焦点；Monaco 内由 addCommand 处理）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (hostRef.current?.contains(event.target as Node)) return;
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  const fileSymbols = symbols.data?.symbols ?? [];
  const currentSymbol = symbolAtLine(fileSymbols, cursorLine);
  const segments = path.split("/");

  return (
    <section className="editor-pane" aria-label={t(`编辑器：${path}`, `Editor: ${path}`)}>
      <header className="editor-pane-header">
        <nav className="editor-breadcrumb" aria-label={t("面包屑", "Breadcrumb")}>
          {segments.map((segment, index) => (
            <span key={index} className="editor-breadcrumb-item">
              {index > 0 && <span className="editor-breadcrumb-sep">›</span>}
              {index === segments.length - 1 ? <strong>{segment}</strong> : segment}
            </span>
          ))}
          {currentSymbol && (
            <button
              className="editor-breadcrumb-item editor-breadcrumb-symbol"
              title={t(`跳转到符号（第 ${currentSymbol.startLine} 行）`, `Go to symbol (line ${currentSymbol.startLine})`)}
              onClick={() => {
                editorRef.current?.setPosition({ lineNumber: currentSymbol.startLine, column: 1 });
                editorRef.current?.revealLineInCenter(currentSymbol.startLine);
                editorRef.current?.focus();
              }}
            >
              <span className="editor-breadcrumb-sep">›</span>
              {currentSymbol.name}
            </button>
          )}
        </nav>
        <div className="editor-pane-actions">
          {dirty && <span className="editor-dirty" title={t("有未保存的修改", "Unsaved changes")}>●</span>}
          {!saveBlocked && (
            <button
              className="btn small"
              disabled={!dirty || saving}
              onClick={save}
              aria-keyshortcuts="Control+s Meta+s"
            >
              {saving ? t("保存中…", "Saving…") : t("保存", "Save")}
            </button>
          )}
          <button className="icon-btn" aria-label={t("回到对话（Esc）", "Back to conversation (Esc)")} onClick={requestClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>
      {readOnly && (
        <p className="editor-pane-note">{t("Plan 模式为只读：编辑器已锁定，切换到 build 模式后可保存。", "Plan mode is read-only: the editor is locked. Switch to build mode to save.")}</p>
      )}
      {content.data?.truncated && (
        <p className="editor-pane-note">{t("文件过大，仅加载了截断内容，保存已禁用。", "File is too large; only truncated content was loaded and saving is disabled.")}</p>
      )}
      <div className="editor-pane-body">
        {content.isPending && <p className="wb-overlay-hint">{t("加载中…", "Loading…")}</p>}
        {content.isError && (
          <p className="wb-overlay-hint">{t(`无法读取文件：${content.error instanceof Error ? content.error.message : "未知错误"}`, `Could not read file: ${content.error instanceof Error ? content.error.message : "unknown error"}`)}</p>
        )}
        {code !== undefined && monacoFailed && (
          <>
            <p className="editor-pane-note">{t("编辑器加载失败，已降级为只读代码视图。", "The editor failed to load; falling back to the read-only code view.")}</p>
            <CodeView code={code} lang={langFromPath(path)} {...(line ? { targetLine: line } : {})} {...(column ? { targetColumn: column } : {})} />
          </>
        )}
        {code !== undefined && !monacoFailed && <div ref={hostRef} className="editor-host" data-testid="monaco-host" />}
      </div>
    </section>
  );
}
