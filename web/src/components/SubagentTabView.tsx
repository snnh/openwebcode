import { useMemo, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LiveSubagentRun } from "../lib/contracts";
import { groupSubagentRuns, SubagentRunRow } from "./panels/SubagentsPanel";
import { SubagentRunStats, SubagentStatusChip } from "./SubagentRunCard";
import { MemoMessageCard } from "./MessageCard";
import { useI18n } from "../i18n";

/** 终态子代理的完整转录：消息经主对话同款 MessageCard 渲染，观感与「对话」标签一致 */
function SubagentTabTranscript({ sessionId, run }: { sessionId: string; run: LiveSubagentRun }): ReactElement {
  const { t } = useI18n();
  const transcript = useQuery({
    queryKey: ["subagent-transcript", sessionId, run.taskId],
    queryFn: () => api.subagentTranscript(sessionId, run.taskId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (transcript.isPending) {
    return <p className="subagent-transcript-status">{t("加载中…", "Loading…")}</p>;
  }
  if (transcript.isError) {
    return <p className="subagent-transcript-status">{t("转录加载失败", "Failed to load transcript")}</p>;
  }
  // 与主对话一致的轮次编号（user 消息开启一轮），保持子代理标签与「对话」标签的轮次深浅一致
  const turnOf: number[] = [];
  let turn = 0;
  for (const message of transcript.data.messages) {
    if (message.role === "user") turn += 1;
    turnOf.push(turn);
  }
  return (
    <div className="subagent-tab-messages">
      {transcript.data.messages.map((message, index) => (
        <MemoMessageCard key={message.id} message={message} sessionId={sessionId} turn={turnOf[index]} />
      ))}
    </div>
  );
}

/** 标签内单个子代理运行：运行中显示实时状态行 + 提示；终态显示头部（状态/轮次/代理徽标）+ 对话式转录 */
function SubagentTabRun({ sessionId, run, swarm }: { sessionId: string; run: LiveSubagentRun; swarm: boolean }): ReactElement {
  const { t } = useI18n();
  if (run.status === "running") {
    return (
      <section className="subagent-tab-run" data-status="running">
        <ul className="subagent-run-items">
          <SubagentRunRow run={run} sessionId={sessionId} />
        </ul>
        <p className="subagent-tab-hint">{t("运行结束后显示完整对话", "The full conversation will appear here once the run finishes.")}</p>
      </section>
    );
  }
  return (
    <section className="subagent-tab-run" data-status={run.status}>
      <header className="subagent-tab-run-header">
        {swarm && run.swarm && <span className="subagent-run-index mono">{t(`任务 ${run.swarm.index}`, `Task ${run.swarm.index}`)}</span>}
        {run.agent && <span className="subagent-run-agent mono">{run.agent}</span>}
        <SubagentStatusChip status={run.status} />
        <SubagentRunStats run={run} />
      </header>
      <SubagentTabTranscript sessionId={sessionId} run={run} />
    </section>
  );
}

/**
 * 主区子代理标签内容：按标签的 toolCallId 过滤出该次 spawn 调用的运行组。
 * 终态运行的转录用主对话同款 MessageCard 渲染（与「对话」标签观感一致）；
 * 运行中的子代理转录尚未落盘，只显示实时状态行。实时与历史运行通用（同一 merged runs 数据源）。
 */
export function SubagentTabView({ sessionId, toolCallId, runs }: {
  sessionId: string;
  /** 该标签对应的 spawn 调用 */
  toolCallId: string;
  /** 当前会话合并后的子代理运行（taskId → run），App 下发 */
  runs: Record<string, LiveSubagentRun>;
}): ReactElement {
  const { t } = useI18n();
  const group = useMemo(() => groupSubagentRuns(runs).find((entry) => entry.toolCallId === toolCallId), [runs, toolCallId]);

  if (!group) {
    return (
      <p className="muted-empty panel-empty subagent-tab-empty">
        {t("该标签对应的子代理运行已不在记录中。", "The subagent runs for this tab are no longer recorded.")}
      </p>
    );
  }

  const done = group.runs.filter((run) => run.status === "done").length;
  const failed = group.runs.filter((run) => run.status === "failed").length;
  const running = group.runs.filter((run) => run.status === "running").length;
  return (
    <div className="subagent-tab-view">
      {group.swarm && (
        <header className="subagents-group-header">
          {t(
            `Swarm ${group.total} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
            `Swarm · ${group.total} items · ${done} done / ${failed} failed / ${running} running`,
          )}
        </header>
      )}
      {group.runs.map((run) => <SubagentTabRun key={run.taskId} sessionId={sessionId} run={run} swarm={group.swarm} />)}
    </div>
  );
}
