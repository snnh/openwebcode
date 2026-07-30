import { useState, type ReactElement, type ReactNode } from "react";
import type { LiveSubagentRun } from "../lib/contracts";
import { snippet, swarmItems } from "../lib/subagent-runs";
import { Icon } from "./Icon";
import { SubagentTranscriptDetails } from "./MessageCard";
import { useI18n } from "../i18n";

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
      {status === "running" && <span className="subagent-run-spinner" aria-hidden />}
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

/** 与 tool-row 同款的行头：图标 + 名称 + 摘要 + 右侧「查看」+ chevron */
function RowHeader({ open, onToggle, children }: { open: boolean; onToggle(): void; children: ReactNode }): ReactElement {
  const { t } = useI18n();
  return (
    <div
      className="subagent-run-header"
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

/** spawn_task / spawn_swarm 工具调用的紧凑折叠行：行头常驻，统计/逐项状态/转录链接展开后显示 */
export function SubagentRunCard({ name, input, sessionId, live }: {
  name: string;
  input?: Record<string, unknown>;
  sessionId?: string | undefined;
  /** 该工具调用（toolCallId）关联的实时子代理运行；空/缺省表示历史卡片 */
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
                const task = run?.prompt ?? item?.task ?? "";
                return (
                  <li key={index} className="subagent-run-item" data-status={run?.status ?? (live && live.length > 0 ? "pending" : undefined)}>
                    <span className="subagent-run-index mono">{index + 1}/{total}</span>
                    {agent && <span className="subagent-run-agent mono">{agent}</span>}
                    {task && <span className="subagent-run-task" title={task}>{snippet(task, 80)}</span>}
                    {run ? <SubagentStatusChip status={run.status} /> : live && live.length > 0 ? <SubagentStatusChip status="pending" /> : null}
                    {run && <SubagentRunStats run={run} />}
                    {run && (run.status === "done" || run.status === "failed") && sessionId && (
                      <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} index={index + 1} />
                    )}
                  </li>
                );
              })}
            </ul>
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
        <b className="mono">spawn_task</b>
        <span className="subagent-run-label">{t("子代理", "Subagent")}</span>
        {agent && <span className="subagent-run-agent mono">{agent}</span>}
        {prompt && <span className="subagent-run-summary mono" title={prompt}>{snippet(prompt)}</span>}
        {run && <SubagentStatusChip status={run.status} />}
      </RowHeader>
      {open && (run || prompt) && (
        <div className="subagent-run-body">
          <p className="subagent-run-fullprompt">{prompt}</p>
          {run && <SubagentRunStats run={run} />}
          {run && (run.status === "done" || run.status === "failed") && sessionId && <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} />}
        </div>
      )}
    </section>
  );
}
