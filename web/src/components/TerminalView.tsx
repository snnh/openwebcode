import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { ChatMessage, SessionDetail } from "../lib/contracts";
import { shellCommandOf, toolResultIsError, toolResultOf } from "../lib/shell-messages";
import { useI18n } from "../i18n";

interface TerminalEntry {
  id: string;
  /** 命令文本（不含 `!` 前缀） */
  cmd: string;
  /** 输出；undefined 表示已提交、结果尚未回传 */
  output?: string;
  isError?: boolean;
}

/** 历史条数上限：只渲染最近 N 条命令记录，长会话不拖垮布局 */
const HISTORY_LIMIT = 200;

/** 会话消息 → 终端历史：user `!cmd` + 紧随的 tool_result 配对（无配对则视为执行中） */
export function deriveTerminalEntries(messages: readonly ChatMessage[]): TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const raw = shellCommandOf(message);
    if (raw === undefined) continue;
    const result = messages[index + 1]?.role === "tool" ? messages[index + 1] : undefined;
    entries.push({
      id: message.id,
      cmd: raw.slice(1).trim(),
      ...(result ? { output: toolResultOf(result), isError: toolResultIsError(result) } : {}),
    });
    if (result) index += 1;
  }
  return entries.slice(-HISTORY_LIMIT);
}

/**
 * 终端标签内容：每会话一个 shell 控制台。
 * 历史从会话消息派生（user `!cmd` + tool_result 配对）；底部输入行经 api.runShell 提交（202 异步），
 * 结果经既有消息流回落到 session.messages，本组件无需轮询。
 */
export function TerminalView({ session, onNotice }: {
  session: SessionDetail;
  onNotice?(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 已提交但尚未经消息流回传的命令（乐观展示「执行中…」；同名命令出现在历史后自动撤下）
  const [pending, setPending] = useState<TerminalEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyStashRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const localSeqRef = useRef(0);

  const derived = useMemo(() => deriveTerminalEntries(session.messages), [session.messages]);
  const visiblePending = pending.filter((entry) => !derived.some((item) => item.cmd === entry.cmd));
  const entries = useMemo(() => [...derived, ...visiblePending], [derived, visiblePending]);
  // ↑/↓ 输入历史：仅 shell 命令（最新在前），与消息派生历史同源
  const history = useMemo(() => derived.map((entry) => entry.cmd).reverse(), [derived]);

  // 切换会话时清空本地待回传记录与输入状态
  useEffect(() => {
    setPending([]);
    setDraft("");
    setHistoryIndex(null);
  }, [session.id]);

  // 新记录到底时自动滚到底部
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries.length]);

  const submit = async (): Promise<void> => {
    const cmd = draft.trim();
    if (!cmd || submitting) return;
    setSubmitting(true);
    try {
      // 202 异步接受；409（agent 运行中/有 shell 挂起）等错误 toast 反馈
      await api.runShell(session.id, cmd);
      localSeqRef.current += 1;
      setPending((previous) => [...previous, { id: `local-${localSeqRef.current}`, cmd }]);
      setDraft("");
      setHistoryIndex(null);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : t("命令提交失败", "Could not run the command"), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="terminal-view">
      <div className="terminal-cwd mono" title={session.cwd}>{session.cwd}</div>
      <div className="terminal-scroll" ref={scrollRef}>
        {entries.length === 0 && (
          <p className="terminal-empty">{t("还没有命令记录。在下方输入命令，Enter 执行。", "No commands yet. Type a command below and press Enter to run it.")}</p>
        )}
        {entries.map((entry) => (
          <div className="terminal-entry" key={entry.id}>
            <div className="terminal-cmd mono">$ {entry.cmd}</div>
            {entry.output === undefined ? (
              <p className="terminal-pending">{t("执行中…", "Running…")}</p>
            ) : entry.output ? (
              <pre className={`terminal-output mono${entry.isError ? " error" : ""}`}>{entry.output}</pre>
            ) : null}
          </div>
        ))}
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt mono" aria-hidden>$</span>
        <input
          className="terminal-input mono"
          value={draft}
          disabled={submitting}
          placeholder={t("输入命令，Enter 执行", "Type a command, Enter to run")}
          aria-label={t("终端命令输入", "Terminal command input")}
          onChange={(event) => {
            setDraft(event.target.value);
            if (historyIndex !== null) setHistoryIndex(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "ArrowUp" && history.length > 0) {
              event.preventDefault();
              if (historyIndex === null) historyStashRef.current = draft;
              const next = Math.min((historyIndex ?? -1) + 1, history.length - 1);
              if (next !== historyIndex) {
                setHistoryIndex(next);
                setDraft(history[next]!);
              }
            } else if (event.key === "ArrowDown" && historyIndex !== null) {
              event.preventDefault();
              if (historyIndex === 0) {
                setHistoryIndex(null);
                setDraft(historyStashRef.current);
              } else {
                setHistoryIndex(historyIndex - 1);
                setDraft(history[historyIndex - 1]!);
              }
            }
          }}
        />
      </div>
    </div>
  );
}
