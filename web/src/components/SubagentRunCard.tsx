import type { ReactElement } from "react";
import type { LiveSubagentRun } from "../lib/contracts";
import { Icon } from "./Icon";
import { SubagentTranscriptDetails } from "./MessageCard";
import { useI18n } from "../i18n";

/** spawn_swarm items 的两种形态：纯字符串或 { task, agent? }（与 server 端解析一致） */
function swarmItems(input?: Record<string, unknown>): Array<{ task: string; agent?: string }> {
  if (!Array.isArray(input?.items)) return [];
  return input.items.map((raw) => {
    if (typeof raw === "string") return { task: raw };
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
      return { task: String(record.task ?? ""), ...(agent ? { agent } : {}) };
    }
    return { task: String(raw) };
  });
}

function snippet(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

function StatusChip({ status }: { status: "pending" | LiveSubagentRun["status"] }): ReactElement {
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

function RunStats({ run }: { run: LiveSubagentRun }): ReactElement {
  const { t } = useI18n();
  if (run.status === "failed") return <span className="subagent-run-error">{run.error ?? t("未知错误", "unknown error")}</span>;
  const tools = run.toolsUsed.length > 0 ? run.toolsUsed.join(", ") : undefined;
  return (
    <span className="subagent-run-stats">
      {run.status === "running"
        ? t(`第 ${run.turns} 轮${tools ? ` · 已用 ${tools}` : ""}`, `Turn ${run.turns}${tools ? ` · used ${tools}` : ""}`)
        : t(`${run.turns} 轮${tools ? ` · ${tools}` : ""}`, `${run.turns} turns${tools ? ` · ${tools}` : ""}`)}
    </span>
  );
}

/** spawn_task / spawn_swarm 工具调用的专用卡片：运行期间展示实时进度，结束后由持久化 tool_result 接管 */
export function SubagentRunCard({ name, input, sessionId, live }: {
  name: string;
  input?: Record<string, unknown>;
  sessionId?: string | undefined;
  /** 该工具调用（toolCallId）关联的实时子代理运行；空/缺省表示历史卡片 */
  live?: LiveSubagentRun[] | undefined;
}): ReactElement {
  const { t } = useI18n();
  const callAgent = typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : undefined;

  if (name === "spawn_swarm") {
    const items = swarmItems(input);
    const liveTotal = live?.find((run) => run.swarm)?.swarm?.total ?? 0;
    const total = Math.max(items.length, liveTotal);
    return (
      <section className="tool-card subagent-run">
        <header>
          <span className="tool-icon" aria-hidden><Icon name="layers" size={13} /></span>
          <b className="mono">spawn_swarm</b>
          <span className="subagent-run-label">{t("子代理组", "Subagent swarm")}</span>
          {total > 0 && <span className="subagent-run-count">{t(`${total} 项`, `${total} items`)}</span>}
        </header>
        {typeof input?.prompt_template === "string" && input.prompt_template && (
          <p className="tool-summary" title={input.prompt_template}>{snippet(input.prompt_template)}</p>
        )}
        {total > 0 && (
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
                  {run ? <StatusChip status={run.status} /> : live && live.length > 0 ? <StatusChip status="pending" /> : null}
                  {run && <RunStats run={run} />}
                  {run && run.status === "done" && sessionId && (
                    <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} index={index + 1} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  const run = live?.[0];
  const prompt = run?.prompt ?? (typeof input?.prompt === "string" ? input.prompt : "");
  const agent = run?.agent ?? callAgent;
  return (
    <section className="tool-card subagent-run">
      <header>
        <span className="tool-icon" aria-hidden><Icon name="layers" size={13} /></span>
        <b className="mono">spawn_task</b>
        <span className="subagent-run-label">{t("子代理", "Subagent")}</span>
        {agent && <span className="subagent-run-agent mono">{agent}</span>}
        {run && <StatusChip status={run.status} />}
      </header>
      {prompt && <p className="tool-summary" title={prompt}>{snippet(prompt)}</p>}
      {run && <RunStats run={run} />}
      {run && run.status === "done" && sessionId && <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} />}
    </section>
  );
}
