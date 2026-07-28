import { useMemo, type ReactElement } from "react";
import type { LiveSubagentRun } from "../../lib/contracts";
import { snippet } from "../../lib/subagent-runs";
import { SubagentRunStats, SubagentStatusChip } from "../SubagentRunCard";
import { SubagentTranscriptDetails } from "../MessageCard";
import { useI18n } from "../../i18n";

interface RunGroup {
  toolCallId: string;
  /** swarm 组（spawn_swarm 一次调用的全部子代理）或独立 spawn_task */
  swarm: boolean;
  total: number;
  runs: LiveSubagentRun[];
}

/** 按 toolCallId 归组（swarm 项聚在一次 spawn_swarm 调用下），组间按最新在前排序 */
function groupRuns(runs: Record<string, LiveSubagentRun>): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const run of Object.values(runs)) {
    const group = groups.get(run.toolCallId);
    if (group) {
      group.runs.push(run);
      group.total = Math.max(group.total, run.swarm?.total ?? 1);
      group.swarm = group.swarm || Boolean(run.swarm);
    } else {
      groups.set(run.toolCallId, { toolCallId: run.toolCallId, swarm: Boolean(run.swarm), total: run.swarm?.total ?? 1, runs: [run] });
    }
  }
  for (const group of groups.values()) {
    group.runs.sort((a, b) => (a.swarm?.index ?? 0) - (b.swarm?.index ?? 0));
  }
  // 插入顺序即发生顺序，反转为最新在前
  return [...groups.values()].reverse();
}

function RunRow({ run, sessionId }: { run: LiveSubagentRun; sessionId: string }): ReactElement {
  return (
    <li className="subagent-run-item" data-status={run.status}>
      {run.swarm && <span className="subagent-run-index mono">{run.swarm.index}/{run.swarm.total}</span>}
      {run.agent && <span className="subagent-run-agent mono">{run.agent}</span>}
      {run.prompt && <span className="subagent-run-task" title={run.prompt}>{snippet(run.prompt, 80)}</span>}
      <SubagentStatusChip status={run.status} />
      <SubagentRunStats run={run} />
      {run.status === "done" && (
        <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} {...(run.swarm ? { index: run.swarm.index } : {})} />
      )}
    </li>
  );
}

/** 子代理面板：当前会话全部 spawn_task / spawn_swarm 运行的监视视图（实时 + 历史合并，最新在前） */
export function SubagentsPanel({ sessionId, runs }: {
  sessionId?: string;
  /** 当前会话合并后的子代理运行（taskId → run），App 下发 */
  runs: Record<string, LiveSubagentRun>;
}): ReactElement {
  const { t } = useI18n();
  const groups = useMemo(() => groupRuns(runs), [runs]);

  if (!sessionId || groups.length === 0) {
    return (
      <p className="panel-empty subagents-panel-empty">
        {t(
          "还没有子代理运行记录——agent 运行中可通过 spawn_task / spawn_swarm 派生子代理并行处理任务。",
          "No subagent runs yet — the agent can spawn subagents via spawn_task / spawn_swarm while running.",
        )}
      </p>
    );
  }

  let swarmSeq = 0;
  return (
    <div className="subagents-panel">
      {groups.map((group) => {
        if (!group.swarm) {
          const run = group.runs[0]!;
          return (
            <ul key={group.toolCallId} className="subagent-run-items subagents-group">
              <RunRow run={run} sessionId={sessionId} />
            </ul>
          );
        }
        swarmSeq += 1;
        const done = group.runs.filter((run) => run.status === "done").length;
        const failed = group.runs.filter((run) => run.status === "failed").length;
        const running = group.runs.filter((run) => run.status === "running").length;
        return (
          <section key={group.toolCallId} className="subagents-group">
            <header className="subagents-group-header">
              {t(
                `群 ${swarmSeq} 共 ${group.total} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
                `Swarm ${swarmSeq} · ${group.total} items · ${done} done / ${failed} failed / ${running} running`,
              )}
            </header>
            <ul className="subagent-run-items">
              {group.runs.map((run) => <RunRow key={run.taskId} run={run} sessionId={sessionId} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
