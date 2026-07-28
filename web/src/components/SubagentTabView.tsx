import { useMemo, type ReactElement } from "react";
import type { LiveSubagentRun } from "../lib/contracts";
import { groupSubagentRuns, SubagentRunRow } from "./panels/SubagentsPanel";
import { useI18n } from "../i18n";

/**
 * 主区子代理标签内容：按标签的 toolCallId 过滤出该次 spawn 调用的运行组，
 * 复用子代理面板的行渲染（实时进度 + 完成后可展开的转录）。实时与历史运行通用（同一 merged runs 数据源）。
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
      <p className="panel-empty subagent-tab-empty">
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
            `群 ${group.total} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
            `Swarm · ${group.total} items · ${done} done / ${failed} failed / ${running} running`,
          )}
        </header>
      )}
      <ul className="subagent-run-items">
        {group.runs.map((run) => <SubagentRunRow key={run.taskId} run={run} sessionId={sessionId} />)}
      </ul>
    </div>
  );
}
