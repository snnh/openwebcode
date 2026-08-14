import { useMemo, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentInfo, LiveSubagentRun } from "../lib/contracts";
import { deriveSubagentRunsFromMessages, mergeSubagentRuns, snippet } from "../lib/subagent-runs";
import { SubagentRunStats, SubagentStatusChip, SubagentTranscriptDetails } from "../chat/SubagentRunCard";
import { useLiveSubagentRuns } from "../app/live-store";
import { useSessionQuery } from "../app/queries";
import { tabActions } from "../workbench/tab-actions";
import { useI18n } from "../i18n";

interface SubagentRunGroup {
  toolCallId: string;
  /** swarm 组（spawn_swarm 一次调用的全部子代理）或独立 spawn_task */
  swarm: boolean;
  total: number;
  runs: LiveSubagentRun[];
}

/** 按 toolCallId 归组（swarm 项聚在一次 spawn_swarm 调用下），组间按最新在前排序；主区子代理标签视图复用 */
export function groupSubagentRuns(runs: Record<string, LiveSubagentRun>): SubagentRunGroup[] {
  const groups = new Map<string, SubagentRunGroup>();
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

/** 单个子代理运行行（状态徽标 + 实时轮次/工具 + 终态（完成/失败）后的转录折叠）；子代理面板与主区标签视图共用 */
export function SubagentRunRow({ run, sessionId, onOpenInTab }: {
  run: LiveSubagentRun;
  sessionId: string;
  /** 桌面端「在标签中打开」（按所在组的 toolCallId 开主区标签）；缺省不渲染按钮 */
  onOpenInTab?: ((toolCallId: string) => void) | undefined;
}): ReactElement {
  const { t } = useI18n();
  return (
    <li className="subagent-run-item" data-status={run.status}>
      {run.swarm && <span className="subagent-run-index mono">{run.swarm.index}/{run.swarm.total}</span>}
      {run.agent && <span className="subagent-run-agent mono">{run.agent}</span>}
      {run.prompt && <span className="subagent-run-task" title={run.prompt}>{snippet(run.prompt, 80)}</span>}
      <SubagentStatusChip status={run.status} />
      <SubagentRunStats run={run} />
      {onOpenInTab && (
        <button type="button" className="subagents-open-tab" onClick={() => onOpenInTab(run.toolCallId)}>
          {t("在标签中打开", "Open in tab")}
        </button>
      )}
      {(run.status === "done" || run.status === "failed") && (
        <SubagentTranscriptDetails sessionId={sessionId} taskId={run.taskId} {...(run.swarm ? { index: run.swarm.index } : {})} />
      )}
    </li>
  );
}

/** api.agents() 不可用时的兜底选项（内置两类），保证启动器始终可用 */
const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "explore", name: "explore", description: "", builtin: true },
  { id: "general", name: "general", description: "", builtin: true },
];

/** 手动启动子代理：输入任务 + 选择代理类型（内置在前），成功后经 WS subagent.started 自动进入运行列表与标签 */
function SubagentLauncher({ sessionId }: { sessionId: string }): ReactElement {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  // 手动启动的意图是干活，默认可写的通用代理
  const [agent, setAgent] = useState("general");
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: () => api.agents(), staleTime: 300_000, retry: false });
  const start = useMutation({
    mutationFn: (body: { prompt: string; agent: string }) => api.startSubagent(sessionId, body),
    onSuccess: () => setPrompt(""),
  });
  const agents = useMemo(() => {
    const list = agentsQuery.data?.agents ?? FALLBACK_AGENTS;
    return [...list].sort((a, b) => Number(b.builtin) - Number(a.builtin));
  }, [agentsQuery.data]);
  const submit = (): void => {
    const text = prompt.trim();
    if (!text || start.isPending) return;
    start.mutate({ prompt: text, agent });
  };
  return (
    <form
      className="subagent-launcher"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className="input subagent-launcher-input"
        value={prompt}
        placeholder={t("描述子代理任务…", "Describe the subagent task…")}
        aria-label={t("子代理任务描述", "Subagent task description")}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <select
        className="subagent-launcher-agent"
        aria-label={t("子代理类型", "Subagent type")}
        value={agent}
        onChange={(event) => setAgent(event.target.value)}
      >
        {agents.map((item) => (
          <option key={item.id} value={item.id}>
            {item.builtin ? t(`${item.name}（内置）`, `${item.name} (builtin)`) : t(`${item.name}（自定义）`, `${item.name} (custom)`)}
          </option>
        ))}
      </select>
      <button type="submit" className="btn small" disabled={!prompt.trim() || start.isPending}>
        {start.isPending ? t("启动中…", "Launching…") : t("启动", "Launch")}
      </button>
      {start.isError && (
        <p className="subagent-launcher-error" role="alert">
          {start.error instanceof Error ? start.error.message : t("启动子代理失败", "Failed to launch the subagent")}
        </p>
      )}
    </form>
  );
}

const EMPTY_MESSAGE = (
  "还没有子代理运行记录——agent 运行中可通过 spawn_task / spawn_swarm 派生子代理并行处理任务。"
);

/** 子代理面板：顶部手动启动器 + 当前会话全部 spawn_task / spawn_swarm 运行的监视视图。
 *  运行列表自取：实时运行（live-store，终态保留）+ 从已加载会话消息推导的历史运行合并，实时条目优先，最新在前。
 *  「在标签中打开」经 tabActions.openSubagentTab（App 装配层注册；未注册时不渲染按钮）。 */
export function SubagentsPanel({ sessionId }: { sessionId?: string | undefined }): ReactElement {
  const { t } = useI18n();
  const liveRuns = useLiveSubagentRuns(sessionId);
  const session = useSessionQuery(sessionId);
  const derivedRuns = useMemo(() => deriveSubagentRunsFromMessages(session.data?.messages ?? []), [session.data]);
  const runs = useMemo(() => mergeSubagentRuns(liveRuns, derivedRuns), [liveRuns, derivedRuns]);
  const groups = useMemo(() => groupSubagentRuns(runs), [runs]);
  const onOpenInTab = tabActions.openSubagentTab;

  if (!sessionId) {
    return (
      <p className="muted-empty panel-empty subagents-panel-empty">
        {t(EMPTY_MESSAGE, "No subagent runs yet — the agent can spawn subagents via spawn_task / spawn_swarm while running.")}
      </p>
    );
  }

  let swarmSeq = 0;
  return (
    <div className="subagents-panel">
      <SubagentLauncher sessionId={sessionId} />
      {groups.length === 0 && (
        <p className="muted-empty panel-empty subagents-panel-empty">
          {t(EMPTY_MESSAGE, "No subagent runs yet — the agent can spawn subagents via spawn_task / spawn_swarm while running.")}
        </p>
      )}
      {groups.map((group) => {
        if (!group.swarm) {
          const run = group.runs[0]!;
          return (
            <ul key={group.toolCallId} className="subagent-run-items subagents-group">
              <SubagentRunRow run={run} sessionId={sessionId} {...(onOpenInTab ? { onOpenInTab } : {})} />
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
                `Swarm ${swarmSeq} 共 ${group.total} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
                `Swarm ${swarmSeq} · ${group.total} items · ${done} done / ${failed} failed / ${running} running`,
              )}
              {onOpenInTab && (
                <button type="button" className="subagents-open-tab" onClick={() => onOpenInTab(group.toolCallId)}>
                  {t("在标签中打开", "Open in tab")}
                </button>
              )}
            </header>
            <ul className="subagent-run-items">
              {group.runs.map((run) => <SubagentRunRow key={run.taskId} run={run} sessionId={sessionId} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
