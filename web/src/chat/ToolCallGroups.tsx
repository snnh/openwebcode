import { useState, type ReactElement } from "react";
import type { MessageContent } from "../lib/contracts";
import { diffSpecForTool, formatToolContent, summarizeToolInput } from "../lib/tool-format";
import { Icon } from "../components/Icon";
import { CodeBlock } from "../components/Markdown";
import { useI18n } from "../i18n";
import { useChatActions, type DiffSpec } from "./types";
import type { ToolCallStatus } from "./MessageCard";

/** 组内一行的归一化视图：历史（参数 JSON + 配对结果）与流式（参数增量原文）共用。 */
export interface ToolGroupCall {
  id: string;
  /** 工具名；孤儿结果行（无配对调用）为空串，渲染时回退为「执行结果」 */
  name: string;
  status?: ToolCallStatus | undefined;
  /** 参数摘要（命令/路径等） */
  summary?: string | undefined;
  /** 展开区参数文本：历史为 pretty JSON；流式为参数增量原文（argsStreaming=true） */
  argsText?: string | undefined;
  argsStreaming?: boolean;
  /** write_file/edit_file 的文件变化规格，经 ChatActions.onOpenDiff 在统一 diff 视图打开 */
  diffSpec?: DiffSpec | undefined;
  /** 配对的 tool_result（按 toolCallId 合并到同一行） */
  result?: { error: boolean; summary?: string | undefined; body: string } | undefined;
}

function resultViewOf(block: MessageContent): NonNullable<ToolGroupCall["result"]> {
  const error = Boolean(block.isError);
  const content = block.content ?? "";
  const formatted = error ? undefined : formatToolContent(content);
  return { error, summary: formatted?.summary, body: formatted ? formatted.body : content };
}

/**
 * 历史块序列 → 组内行：tool_call 与配对的 tool_result（按 toolCallId）合并到同一行；
 * 无配对调用的孤儿结果以纯结果行附加在末尾。
 */
export function groupCallsFromBlocks(
  blocks: MessageContent[],
  toolResults?: Record<string, boolean> | undefined,
  running?: boolean,
): ToolGroupCall[] {
  const resultsByCallId = new Map<string, MessageContent>();
  for (const block of blocks) {
    if (block.type === "tool_result" && block.toolCallId) resultsByCallId.set(block.toolCallId, block);
  }
  const calls: ToolGroupCall[] = [];
  const pairedCallIds = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "tool_call") continue;
    if (block.id) pairedCallIds.add(block.id);
    const status: ToolCallStatus | undefined = block.id && toolResults
      ? block.id in toolResults
        ? toolResults[block.id] ? "error" : "done"
        : running ? "running" : undefined
      : undefined;
    const input = block.input;
    const argsText = JSON.stringify(input ?? {}, null, 2);
    const resultBlock = block.id ? resultsByCallId.get(block.id) : undefined;
    calls.push({
      id: block.id ?? `call-${calls.length}`,
      name: block.name ?? "tool",
      status,
      summary: summarizeToolInput(input),
      argsText,
      diffSpec: diffSpecForTool(block.name ?? "", input),
      result: resultBlock ? resultViewOf(resultBlock) : undefined,
    });
  }
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    if (block.toolCallId && pairedCallIds.has(block.toolCallId)) continue;
    const result = resultViewOf(block);
    calls.push({ id: block.toolCallId ?? `result-${calls.length}`, name: "", status: result.error ? "error" : "done", result });
  }
  return calls;
}

/** 状态图标：running 脉动圆点 / error 叉 / done 勾 / 无状态扳手（行头与组头共用） */
export function ToolStatusIcon({ status }: { status: ToolCallStatus | undefined }): ReactElement {
  if (status === "running") return <span className="tool-row-dot" />;
  if (status === "error") return <Icon name="x" size={12} />;
  if (status === "done") return <Icon name="check" size={12} />;
  return <Icon name="wrench" size={12} />;
}

/** 组内单行（状态图标 + 工具名 + 参数摘要 + 展开查看参数/结果）；也用于流式孤立单调用卡。 */
export function ToolCallGroupRow({ call }: { call: ToolGroupCall }): ReactElement {
  const { t } = useI18n();
  const { onOpenDiff, onOpenFile } = useChatActions();
  const [open, setOpen] = useState(false);
  const status = call.status;
  const toggle = (): void => setOpen((value) => !value);
  const hasParams = Boolean(call.argsText && call.argsText !== "{}");
  const summary = call.summary ?? call.result?.summary ?? undefined;
  // 文件提及链接仅对携带路径的 diff 形态（agent 写入/编辑）可用；checkpoint 形态无 path
  const diffPath = call.diffSpec && (call.diffSpec.source === "agent-write" || call.diffSpec.source === "agent-edit" || call.diffSpec.source === "scm")
    ? call.diffSpec.path
    : undefined;
  return (
    <section className={`tool-row tool-group-row${open ? " open" : ""}${status === "error" ? " error" : ""}`}>
      <div
        className="collapse-row tool-row-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
      >
        <span className={`tool-row-status ${status ?? "idle"}`} aria-hidden>
          <ToolStatusIcon status={status} />
        </span>
        <b className="mono tool-row-name">{call.name || t("执行结果", "Result")}</b>
        {summary && <span className="tool-row-summary mono" title={summary}>{summary}</span>}
        <span className="tool-row-actions">
          <button type="button" className="tool-row-view" onClick={(event) => { event.stopPropagation(); toggle(); }}>{t("查看", "View")}</button>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </div>
      {open && (
        <div className="tool-row-body">
          {call.diffSpec && (
            <div className="tool-file-actions">
              <button
                className="btn small tool-diff-open"
                onClick={() => onOpenDiff(call.diffSpec!)}
                aria-label={t("在 diff 视图中打开该文件变化", "Open this file change in the diff view")}
              >
                {t("在 diff 中打开", "Open in diff")}
              </button>
              {onOpenFile && diffPath && (
                <button
                  type="button"
                  className="tool-file-link mono"
                  title={t(`在编辑器中打开 ${diffPath}`, `Open ${diffPath} in the editor`)}
                  onClick={() => onOpenFile(diffPath)}
                >
                  <Icon name="file" size={11} />
                  {diffPath}
                </button>
              )}
            </div>
          )}
          {call.argsStreaming
            ? hasParams && <pre className="mono tool-stream-args">{call.argsText}</pre>
            : hasParams
              ? <CodeBlock lang="json" code={call.argsText!} />
              : !call.result && <p className="tool-row-empty">{t("（无参数）", "(No parameters)")}</p>}
          {call.result && (
            <div className="tool-group-row-result">
              <p className={`tool-group-row-result-label${call.result.error ? " error" : ""}`}>
                {call.result.error ? t("执行失败", "Execution failed") : t("执行结果", "Result")}
                {call.result.summary ? ` · ${call.result.summary}` : ""}
              </p>
              {call.result.body && <pre className="mono">{call.result.body}</pre>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 相邻工具调用合并组：标题行「N 个工具调用 · 已完成/进行中」可折叠，组内一调用一行。
 * 折叠节奏：流式期间 defaultOpen 展开；run 结束由持久化消息接管（历史默认折叠）。
 */
export function ToolCallListGroup({ calls, defaultOpen = false }: { calls: ToolGroupCall[]; defaultOpen?: boolean }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const toggle = (): void => setOpen((value) => !value);
  const running = calls.some((call) => call.status === "running");
  const hasError = calls.some((call) => call.status === "error");
  return (
    <section className={`tool-group${open ? " open" : ""}${hasError ? " error" : ""}`}>
      <div
        className="collapse-row tool-row-header tool-group-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
      >
        <span className={`tool-row-status ${running ? "running" : hasError ? "error" : "done"}`} aria-hidden>
          {running ? <span className="tool-row-dot" /> : <Icon name="list" size={12} />}
        </span>
        <b className="tool-group-title">{t(`${calls.length} 个工具调用`, `${calls.length} tool calls`)}</b>
        <span className="tool-group-state">{running ? `· ${t("进行中", "Running")}` : `· ${t("已完成", "Done")}`}</span>
        <span className="tool-row-actions">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </div>
      {open && (
        <div className="tool-group-body">
          {calls.map((call) => <ToolCallGroupRow key={call.id} call={call} />)}
        </div>
      )}
    </section>
  );
}
