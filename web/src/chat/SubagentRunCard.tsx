import { useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import type { LiveSubagentRun, MessageContent } from "../lib/contracts";
import { snippet, swarmItems } from "../lib/subagent-runs";
import { summarizeToolInput } from "../lib/tool-format";
import { useLiveSubagentSynthesis } from "../app/live-store";
import { tabActions } from "../workbench/tab-actions";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { useI18n } from "../i18n";

/** 四档角色徽标：data-role 着色（premium/balanced/fast/cheap），未识别档位按 balanced 样式。 */
export function SubagentRoleBadge({ role }: { role: string }): ReactElement {
  const { t } = useI18n();
  const labels: Record<string, string> = {
    premium: t("极致", "premium"),
    balanced: t("平衡", "balanced"),
    fast: t("快速", "fast"),
    cheap: t("廉价", "cheap"),
  };
  const known = role in labels;
  return (
    <span className="subagent-run-role" data-role={known ? role : "balanced"}>
      {known ? labels[role] : role}
    </span>
  );
}

/** swarm 卡的「汇总」行：合成轮（synthesize）实时状态（运行中/完成/失败回落）。 */
function SwarmSynthesisRow({ sessionId, toolCallId }: { sessionId?: string | undefined; toolCallId?: string | undefined }): ReactElement | null {
  const { t } = useI18n();
  const synthesis = useLiveSubagentSynthesis(sessionId, toolCallId);
  if (!synthesis) return null;
  return (
    <li className="subagent-run-item subagent-run-synthesis" data-status={synthesis.status}>
      <span className="subagent-run-synthesis-label">{t("汇总", "Synthesis")}</span>
      {synthesis.model && <span className="subagent-run-model mono">{synthesis.model}</span>}
      <SubagentStatusChip status={synthesis.status} />
      {synthesis.status === "failed" && (
        <span className="subagent-run-error">{t("合成失败，已回落原始结论", "Synthesis failed; raw conclusions returned")}{synthesis.error ? ` · ${synthesis.error}` : ""}</span>
      )}
    </li>
  );
}

export function SubagentStatusChip({ status }: { status: "pending" | LiveSubagentRun["status"] }): ReactElement {
  const { t } = useI18n();
  const labels: Record<string, string> = {
    pending: t("排队中", "Queued"),
    running: t("运行中", "Running"),
    done: t("完成", "Done"),
    failed: t("失败", "Failed"),
  };
  return (
    <span className="subagent-run-status" data-status={status}>
      {status === "running" && <span className="subagent-run-pulse" aria-hidden />}
      {labels[status]}
    </span>
  );
}

export function SubagentRunStats({ run }: { run: LiveSubagentRun }): ReactElement | null {
  const { t } = useI18n();
  if (run.status === "failed") return <span className="subagent-run-error">{run.error ?? t("未知错误", "unknown error")}</span>;
  const tools = run.toolsUsed.length > 0 ? run.toolsUsed.join(", ") : undefined;
  // 历史推导的运行无轮次明细（turns=0）：省略「0 轮」避免误导，仅有工具记录时列出工具
  if (run.status === "done" && run.turns === 0) {
    return tools ? <span className="subagent-run-stats">{tools}</span> : null;
  }
  return (
    <span className="subagent-run-stats">
      {run.status === "running"
        ? t(`第 ${run.turns} 轮${tools ? ` · 已用 ${tools}` : ""}`, `Turn ${run.turns}${tools ? ` · used ${tools}` : ""}`)
        : t(`${run.turns} 轮${tools ? ` · ${tools}` : ""}`, `${run.turns} turns${tools ? ` · ${tools}` : ""}`)}
    </span>
  );
}

/** 结论摘录：压平空白后取首 1–2 行（约 limit 字），供终态行默认展示与复制 */
export function conclusionExcerpt(conclusion: string, limit = 160): string {
  const flat = conclusion.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 转录消息折叠阈值：超过后默认只展示最近 N 条（转录可能很长，不做虚拟化） */
const TRANSCRIPT_MESSAGE_FOLD = 20;

/** 转录消息内容的紧凑渲染：assistant 文本用 Markdown，工具调用/结果压缩为单行 */
function TranscriptBlock({ block }: { block: MessageContent }): ReactElement | null {
  const { t } = useI18n();
  switch (block.type) {
    case "text":
      return block.text ? <Markdown>{block.text}</Markdown> : null;
    case "tool_call": {
      const summary = summarizeToolInput(block.input);
      return (
        <p className="subagent-transcript-tool mono">
          <Icon name="wrench" size={11} /> {block.name ?? "tool"}{summary ? ` · ${summary}` : ""}
        </p>
      );
    }
    case "tool_result": {
      const text = block.content ?? "";
      const truncated = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      return (
        <details className="subagent-transcript-result">
          <summary>{block.isError ? t("工具结果（错误）", "Tool result (error)") : t("工具结果", "Tool result")}</summary>
          <pre className="mono">{truncated}</pre>
        </details>
      );
    }
    default:
      return null;
  }
}

const TRANSCRIPT_ROLE_LABELS: Record<string, [string, string]> = { user: ["任务", "Task"], assistant: ["子代理", "Subagent"], tool: ["工具", "Tool"] };

/** subagent/spawn_swarm 工具结果携带的子代理转录：展开时按 taskId 拉取，只读展示。
 *  summarize=true（子代理标签页）时进入即可拉取结论摘要并显示「复制结论」——回顾子代理
 *  产出不必逐项展开转录；面板/对话卡片保持按需拉取，避免一次打开就发很多大请求。 */
export function SubagentTranscriptDetails({ sessionId, taskId, index, summarize = false }: {
  sessionId: string;
  taskId: string;
  index?: number | undefined;
  summarize?: boolean | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 折叠超过 TRANSCRIPT_MESSAGE_FOLD 的历史消息；用户可手动展开全部
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const transcript = useQuery({
    queryKey: ["subagent-transcript", sessionId, taskId],
    queryFn: () => api.subagentTranscript(sessionId, taskId),
    enabled: open || summarize,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const label = index !== undefined
    ? t(`子代理转录 ${index}`, `Subagent transcript ${index}`)
    : t("子代理转录", "Subagent transcript");
  const messages = transcript.data?.messages ?? [];
  const hiddenCount = Math.max(0, messages.length - TRANSCRIPT_MESSAGE_FOLD);
  const shownMessages = hiddenCount > 0 && !showAll ? messages.slice(hiddenCount) : messages;
  const copyConclusion = (): void => {
    void writeClipboard(transcript.data?.conclusion ?? "").then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <>
      {summarize && transcript.data && (
        <div className="subagent-transcript-summary">
          <p className="subagent-transcript-summary-text" title={transcript.data.conclusion}>{conclusionExcerpt(transcript.data.conclusion)}</p>
          <button type="button" className="subagent-transcript-copy" onClick={copyConclusion}>
            {copied ? t("已复制", "Copied") : t("复制结论", "Copy conclusion")}
          </button>
        </div>
      )}
      <details className="subagent-transcript" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && transcript.isPending && <p className="subagent-transcript-status">{t("加载中…", "Loading…")}</p>}
      {open && transcript.isError && <p className="panel-error" role="alert">{t("转录加载失败", "Failed to load transcript")}</p>}
      {open && transcript.data && (
        <div className="subagent-transcript-body">
          <p className="subagent-transcript-meta mono">
            {[
              transcript.data.agent,
              t(`${transcript.data.turns} 轮`, `${transcript.data.turns} turns`),
              transcript.data.toolsUsed.length > 0 ? transcript.data.toolsUsed.join(", ") : undefined,
            ].filter(Boolean).join(" · ")}
          </p>
          <p className="subagent-transcript-prompt">{transcript.data.prompt}</p>
          <Markdown>{transcript.data.conclusion}</Markdown>
          {messages.length > 0 && (
            <details className="subagent-transcript-messages">
              <summary>{t(`消息记录（${messages.length} 条）`, `Messages (${messages.length})`)}</summary>
              {hiddenCount > 0 && (
                <p className="subagent-transcript-status">
                  {!showAll && t(`仅显示最近 ${TRANSCRIPT_MESSAGE_FOLD} 条，已折叠前 ${hiddenCount} 条`, `Showing the last ${TRANSCRIPT_MESSAGE_FOLD}; ${hiddenCount} earlier folded`)}
                  <button type="button" className="subagent-transcript-fold-toggle" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? t("收起", "Collapse") : t(`展开全部 ${messages.length} 条`, `Show all ${messages.length}`)}
                  </button>
                </p>
              )}
              {shownMessages.map((message) => (
                <div key={message.id} className={`subagent-transcript-message ${message.role}`}>
                  <span className="subagent-transcript-role">{TRANSCRIPT_ROLE_LABELS[message.role] ? t(...TRANSCRIPT_ROLE_LABELS[message.role]!) : message.role}</span>
                  {message.content.map((block, blockIndex) => <TranscriptBlock key={blockIndex} block={block} />)}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      </details>
    </>
  );
}

/** 「在标签中打开」：把这次 spawn 调用对应的运行放到主区标签页（深入监控与回顾）。
 *  标签能力未注册（未装配层）或无 toolCallId 时不渲染。 */
function OpenInTabButton({ toolCallId }: { toolCallId: string }): ReactElement | null {
  const { t } = useI18n();
  const open = tabActions.openSubagentTab;
  if (!open) return null;
  return (
    <button type="button" className="subagents-open-tab" onClick={() => open(toolCallId)}>
      {t("在标签中打开", "Open in tab")}
    </button>
  );
}

/** 与 tool-row 同款的行头：图标 + 名称 + 摘要 + 右侧「查看」+ chevron */
function RowHeader({ open, onToggle, children }: { open: boolean; onToggle(): void; children: ReactNode }): ReactElement {
  const { t } = useI18n();
  return (
    <div
      className="collapse-row subagent-run-header"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}
    >
      {children}
      <span className="tool-row-actions">
        <button type="button" className="tool-row-view" onClick={(event) => { event.stopPropagation(); onToggle(); }}>{t("查看", "View")}</button>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </span>
    </div>
  );
}

/** subagent / spawn_swarm 工具调用的紧凑折叠行：行头常驻，统计/逐项状态/转录链接展开后显示 */
export function SubagentRunCard({ name, input, sessionId, toolCallId, live }: {
  name: string;
  input?: Record<string, unknown>;
  sessionId?: string | undefined;
  /** 工具调用 id（合成轮状态按它选择；历史卡片可缺省） */
  toolCallId?: string | undefined;
  /** 该工具调用（toolCallId）关联的实时子代理运行；空/默认表示历史卡片 */
  live?: LiveSubagentRun[] | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = (): void => setOpen((value) => !value);
  const callAgent = typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : undefined;

  if (name === "spawn_swarm") {
    const items = swarmItems(input);
    const liveTotal = live?.find((run) => run.swarm)?.swarm?.total ?? 0;
    const total = Math.max(items.length, liveTotal);
    const template = typeof input?.prompt_template === "string" ? input.prompt_template : "";
    return (
      <section className={`subagent-run${open ? " open" : ""}`}>
        <RowHeader open={open} onToggle={toggle}>
          <span className="subagent-run-icon" aria-hidden><Icon name="layers" size={13} /></span>
          <b className="mono">spawn_swarm</b>
          <span className="subagent-run-label">{t("子代理组", "Subagent swarm")}</span>
          {total > 0 && <span className="subagent-run-count">{t(`${total} 项`, `${total} items`)}</span>}
          {template && <span className="subagent-run-summary mono" title={template}>{snippet(template)}</span>}
        </RowHeader>
        {open && total > 0 && (
          <div className="subagent-run-body">
            <ul className="subagent-run-items">
              {Array.from({ length: total }, (_, index) => {
                const run = live?.find((entry) => entry.swarm?.index === index + 1);
                const item = items[index];
                const agent = run?.agent ?? item?.agent ?? callAgent;
                const role = run?.role ?? item?.role;
                const task = run?.prompt ?? item?.task ?? "";
                return (
                  <li key={index} className="subagent-run-item" data-status={run?.status ?? (live && live.length > 0 ? "pending" : undefined)}>
                    <span className="subagent-run-index mono">{index + 1}/{total}</span>
                    {agent && <span className="subagent-run-agent mono">{agent}</span>}
                    {role && <SubagentRoleBadge role={role} />}
                    {run?.model && <span className="subagent-run-model mono" title={run.model}>{run.model}</span>}
                    {task && <span className="subagent-run-task" title={task}>{snippet(task, 80)}</span>}
                    {run ? <SubagentStatusChip status={run.status} /> : live && live.length > 0 ? <SubagentStatusChip status="pending" /> : null}
                    {run && <SubagentRunStats run={run} />}
                    {run && (run.status === "done" || run.status === "failed") && sessionId && (
                      <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} index={index + 1} />
                    )}
                  </li>
                );
              })}
              <SwarmSynthesisRow sessionId={sessionId} toolCallId={toolCallId} />
            </ul>
            {toolCallId && <OpenInTabButton toolCallId={toolCallId} />}
          </div>
        )}
      </section>
    );
  }

  const run = live?.[0];
  const prompt = run?.prompt ?? (typeof input?.prompt === "string" ? input.prompt : "");
  const agent = run?.agent ?? callAgent;
  return (
    <section className={`subagent-run${open ? " open" : ""}`}>
      <RowHeader open={open} onToggle={toggle}>
        <span className="subagent-run-icon" aria-hidden><Icon name="layers" size={13} /></span>
        <b className="mono">subagent</b>
        <span className="subagent-run-label">{t("子代理", "Subagent")}</span>
        {agent && <span className="subagent-run-agent mono">{agent}</span>}
        {run?.role && <SubagentRoleBadge role={run.role} />}
        {prompt && <span className="subagent-run-summary mono" title={prompt}>{snippet(prompt)}</span>}
        {run && <SubagentStatusChip status={run.status} />}
      </RowHeader>
      {open && (run || prompt) && (
        <div className="subagent-run-body">
          <p className="subagent-run-fullprompt">{prompt}</p>
          {run?.model && <p className="subagent-run-model mono" title={run.model}>{run.model}</p>}
          {run && <SubagentRunStats run={run} />}
          {run && (run.status === "done" || run.status === "failed") && sessionId && <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} />}
          {toolCallId && <OpenInTabButton toolCallId={toolCallId} />}
        </div>
      )}
    </section>
  );
}
