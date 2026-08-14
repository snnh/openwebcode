/**
 * 主区标签条 + 子代理标签内容（二者合一）：
 * - SubagentTabStrip：最左固定「主对话」标签 + 可选终端标签 + 每个 spawn 调用一个动态标签。
 *   标签状态由 App 装配层的 useSubagentTabs/useTerminalTabs 持有（按会话隔离），选中互斥在 ChatView 协调。
 * - SubagentTabView：按标签 toolCallId 过滤出该次 spawn 调用的运行组；运行行复用子代理面板的
 *   SubagentRunRow（运行中显示实时轮次/工具，终态展开 SubagentTranscriptDetails 转录折叠）。
 */
import { useMemo, type ReactElement } from "react";
import type { LiveSubagentRun } from "../lib/contracts";
import { snippet } from "../lib/subagent-runs";
import type { SubagentTab } from "../hooks/use-subagent-tabs";
import { groupSubagentRuns, SubagentRunRow } from "../panels/SubagentsPanel";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

type SubagentTabStatus = "running" | "done" | "failed";

/** 标签状态指示：组内有运行中 → running；否则有失败 → failed；全完成 → done；无运行记录 → undefined */
function subagentTabStatus(runs: Record<string, LiveSubagentRun>, toolCallId: string): SubagentTabStatus | undefined {
  let seen = false;
  let running = false;
  let failed = false;
  for (const run of Object.values(runs)) {
    if (run.toolCallId !== toolCallId) continue;
    seen = true;
    if (run.status === "running") running = true;
    else if (run.status === "failed") failed = true;
  }
  if (!seen) return undefined;
  if (running) return "running";
  if (failed) return "failed";
  return "done";
}

/**
 * 主区标签条：「主对话」+ 终端 + 子代理标签。
 * 运行中且未选中的标签用琥珀色吸引注意；关闭标签只影响视图，不影响子代理运行。
 */
export function SubagentTabStrip({ tabs, runs, selected, terminal, onSelect, onClose, onSelectTerminal, onCloseTerminal }: {
  /** 当前会话的子代理标签（toolCallId 键控，按创建顺序） */
  tabs: SubagentTab[];
  /** 当前会话合并后的子代理运行（状态指示用） */
  runs: Record<string, LiveSubagentRun>;
  /** 选中标签的 toolCallId；undefined 表示「主对话」（或终端选中时的终端） */
  selected: string | undefined;
  /** 终端标签：存在则渲染在「主对话」之后；selected 表示当前选中终端 */
  terminal?: { selected: boolean };
  onSelect(toolCallId?: string): void;
  onClose(toolCallId: string): void;
  onSelectTerminal?(): void;
  onCloseTerminal?(): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="subagent-tabs" role="tablist" aria-label={t("主区标签", "Main tabs")}>
      <button
        type="button"
        role="tab"
        aria-selected={selected === undefined && terminal?.selected !== true}
        className="subagent-tab-main"
        onClick={() => onSelect(undefined)}
      >
        {t("主对话", "Main")}
      </button>
      {terminal && (
        <div className="subagent-tab">
          <button
            type="button"
            role="tab"
            aria-selected={terminal.selected}
            className="subagent-tab-main"
            onClick={() => onSelectTerminal?.()}
          >
            <Icon name="terminal" size={12} />
            <span className="subagent-tab-label">{t("终端", "Terminal")}</span>
          </button>
          <button
            type="button"
            className="subagent-tab-close"
            aria-label={t("关闭标签 终端", "Close tab Terminal")}
            onClick={() => onCloseTerminal?.()}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      )}
      {tabs.map((tab) => {
        const status = subagentTabStatus(runs, tab.toolCallId);
        const isActive = selected === tab.toolCallId;
        const label = tab.swarmTotal !== undefined
          ? t(`群 ${tab.swarmTotal} 项`, `Swarm ×${tab.swarmTotal}`)
          : tab.agent ?? snippet(tab.prompt, 12);
        return (
          <div
            key={tab.toolCallId}
            className={`subagent-tab${status === "running" && !isActive ? " attention" : ""}`}
            {...(status ? { "data-status": status } : {})}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className="subagent-tab-main"
              title={tab.prompt || label}
              onClick={() => onSelect(tab.toolCallId)}
            >
              {status === "running" && <span className="subagent-run-pulse subagent-tab-spinner" aria-hidden />}
              {status && status !== "running" && <span className="subagent-tab-dot" data-status={status} aria-hidden />}
              <span className="subagent-tab-label">{label}</span>
            </button>
            <button
              type="button"
              className="subagent-tab-close"
              aria-label={t(`关闭标签 ${label}`, `Close tab ${label}`)}
              onClick={() => onClose(tab.toolCallId)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 主区子代理标签内容：按标签的 toolCallId 过滤出该次 spawn 调用的运行组。
 * 运行中显示实时状态行（轮次/已用工具）；终态由 SubagentRunRow 内嵌的
 * SubagentTranscriptDetails 提供完整转录折叠（api.subagentTranscript 按 taskId 拉取）。
 */
export function SubagentTabView({ sessionId, toolCallId, runs }: {
  sessionId: string;
  /** 该标签对应的 spawn 调用 */
  toolCallId: string;
  /** 当前会话合并后的子代理运行（taskId → run），ChatView 下发 */
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
      <ul className="subagent-run-items">
        {group.runs.map((run) => <SubagentRunRow key={run.taskId} run={run} sessionId={sessionId} />)}
      </ul>
      {running > 0 && (
        <p className="subagent-tab-hint">{t("运行结束后可在此展开完整转录。", "The full transcript expands here once the run finishes.")}</p>
      )}
    </div>
  );
}
