import { useState, type ReactElement } from "react";
import type { MessageContent } from "../lib/contracts";
import { diffSpecForTool, formatToolContent, summarizeToolInput } from "../lib/tool-format";
import type { DiffSpec } from "./editor/DiffPane";
import { Icon } from "./Icon";
import { CodeBlock } from "./Markdown";
import type { ToolCallStatus } from "./MessageCard";
import { useI18n } from "../i18n";

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
  diffSpec?: DiffSpec | undefined;
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

/** 组内单行（状态图标 + 工具名 + 参数摘要 + 展开查看参数/结果）；也用于流式孤立单调用卡。 */
export function ToolCallGroupRow({ call, onOpenDiff }: { call: ToolGroupCall; onOpenDiff?(spec: DiffSpec): void }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status = call.status;
  const toggle = (): void => setOpen((value) => !value);
  const hasParams = Boolean(call.argsText && call.argsText !== "{}");
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
          {status === "running"
            ? <span className="tool-row-dot" />
            : status === "error"
              ? <Icon name="x" size={12} />
              : status === "done"
                ? <Icon name="check" size={12} />
                : <Icon name="wrench" size={12} />}
        </span>
        <b className="mono tool-row-name">{call.name || t("执行结果", "Result")}</b>
        {call.summary
          ? <span className="tool-row-summary mono" title={call.summary}>{call.summary}</span>
          : call.result?.summary
            ? <span className="tool-row-summary mono" title={call.result.summary}>{call.result.summary}</span>
            : null}
        <span className="tool-row-actions">
          <button type="button" className="tool-row-view" onClick={(event) => { event.stopPropagation(); toggle(); }}>{t("查看", "View")}</button>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </div>
      {open && (
        <div className="tool-row-body">
          {call.diffSpec && onOpenDiff && (
            <button
              className="btn small tool-diff-open"
              onClick={() => onOpenDiff(call.diffSpec!)}
              aria-label={t("在 diff 视图中打开该文件变化", "Open this file change in the diff view")}
            >
              {t("在 diff 中打开", "Open in diff")}
            </button>
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
export function ToolCallListGroup({ calls, defaultOpen = false, onOpenDiff }: { calls: ToolGroupCall[]; defaultOpen?: boolean; onOpenDiff?(spec: DiffSpec): void }): ReactElement {
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
          {calls.map((call) => <ToolCallGroupRow key={call.id} call={call} onOpenDiff={onOpenDiff} />)}
        </div>
      )}
    </section>
  );
}
