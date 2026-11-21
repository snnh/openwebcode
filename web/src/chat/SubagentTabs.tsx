/**
 * 主区标签条 + 子代理标签内容（二者合一）：
 * - SubagentTabStrip：最左固定「主对话」标签 + 可选终端标签 + 每个 spawn 调用一个动态标签。
 *   标签状态由 App 装配层的 useSubagentTabs/useTerminalTabs 持有（按会话隔离），选中互斥在 ChatView 协调。
 * - SubagentTabView：按标签 toolCallId 过滤出该次 spawn 调用的运行组；组内可逐成员切换，
 *   当前成员以 SubagentThread 渲染与主对话同款的消息流（任务/正文/思考/工具调用/工具结果）。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { LiveSubagentRun, TodoItem } from "../lib/contracts";
import { snippet } from "../lib/subagent-runs";
import type { SubagentTab } from "../hooks/use-subagent-tabs";
import { groupSubagentRuns } from "../panels/SubagentsPanel";
import { SubagentRoleBadge, SubagentRunStats, SubagentStatusChip } from "./SubagentRunCard";
import { SubagentThread } from "./SubagentThread";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

type SubagentTabStatus = "running" | "done" | "failed";

/**
 * 标签名：#序号 · 代理名 · 任务摘要（swarm 为 「#n Swarm ×N 项」）。
 * 序号是本会话内该次 spawn 调用的发生顺序——同名代理（两个 explore）靠序号 + 摘要区分，
 * 模型名只显示在标签页内容里（标签保持短，窄屏才放得下）。
 */
export function subagentTabText(tab: SubagentTab, t: (chinese: string, english: string) => string): string {
  if (tab.swarmTotal !== undefined) return `#${tab.seq} ${t(`Swarm ${tab.swarmTotal} 项`, `Swarm ×${tab.swarmTotal}`)}`;
  const parts = [tab.agent, tab.prompt ? snippet(tab.prompt, 12) : undefined].filter(Boolean);
  return `#${tab.seq}${parts.length > 0 ? ` ${parts.join(" · ")}` : ""}`;
}

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
export function SubagentTabStrip({ tabs, runs, selected, terminal, todoItems, onSelect, onClose, onSelectTerminal, onCloseTerminal }: {
  /** 当前会话的子代理标签（toolCallId 键控，按创建顺序） */
  tabs: SubagentTab[];
  /** 当前会话合并后的子代理运行（状态指示用） */
  runs: Record<string, LiveSubagentRun>;
  /** 选中标签的 toolCallId；undefined 表示「主对话」（或终端选中时的终端） */
  selected: string | undefined;
  /** 终端标签：存在则渲染在「主对话」之后；selected 表示当前选中终端 */
  terminal?: { selected: boolean };
  /** 任务清单（标签栏右端折叠 chip；空/无则不渲染） */
  todoItems?: TodoItem[];
  onSelect(toolCallId?: string): void;
  onClose(toolCallId: string): void;
  onSelectTerminal?(): void;
  onCloseTerminal?(): void;
}): ReactElement {
  const { t } = useI18n();
  const todoDone = todoItems?.filter((item) => item.status === "done").length ?? 0;
  const stripRef = useRef<HTMLDivElement>(null);
  // 选中/新增标签时把它滚入视野（横向溢出的标签条不会把当前标签留在视野外）
  useEffect(() => {
    const selectedTab = stripRef.current?.querySelector('[aria-selected="true"]');
    selectedTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected, tabs.length]);
  return (
    <div className="subagent-tabs-row">
      <div className="subagent-tabs" role="tablist" aria-label={t("主区标签", "Main tabs")} ref={stripRef}>
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
          const label = subagentTabText(tab, t);
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
      {/* 溢出兜底：标签多时横向滚动容易把某个标签（含当前标签）推出视野，这里给一个
          「全部」下拉列全（含状态），点击即跳转 —— 下拉必须放在横向滚动容器之外，否则被裁 */}
      {tabs.length > 0 && (
        <details className="subagent-tab-all">
            <summary aria-label={t(`全部子代理标签（${tabs.length}）`, `All subagent tabs (${tabs.length})`)}>
              <Icon name="chevron-down" size={12} />
            </summary>
            <ul>
              {tabs.map((tab) => {
                const status = subagentTabStatus(runs, tab.toolCallId);
                return (
                  <li key={tab.toolCallId} data-status={status ?? "unknown"}>
                    <button
                      type="button"
                      className="subagent-tab-all-item"
                      aria-current={selected === tab.toolCallId}
                      onClick={(event) => {
                        onSelect(tab.toolCallId);
                        event.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      {status === "running" ? <span className="subagent-run-pulse subagent-tab-spinner" aria-hidden />
                        : status ? <span className="subagent-tab-dot" data-status={status} aria-hidden /> : null}
                      <span className="subagent-tab-label">{subagentTabText(tab, t)}</span>
                    </button>
                    <button
                      type="button"
                      className="subagent-tab-close"
                      aria-label={t(`关闭标签 ${subagentTabText(tab, t)}`, `Close tab ${subagentTabText(tab, t)}`)}
                      onClick={() => onClose(tab.toolCallId)}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                );
              })}
          </ul>
        </details>
      )}
      {todoItems && todoItems.length > 0 && (
        <details className="todo-chip">
          <summary>
            {t("任务清单", "Task list")} · {todoDone}/{todoItems.length}
          </summary>
          <ul>
            {todoItems.map((item, index) => (
              <li key={`${item.content}-${index}`} data-status={item.status}>
                <span>{item.status === "done" ? <Icon name="check" size={12} /> : item.status === "in_progress" ? <Icon name="circle-filled" size={10} /> : <Icon name="circle" size={12} />}</span>
                {item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * 主区子代理标签内容：左侧/顶部按运行切换，当前运行以主对话同款消息流展示
 * 「任务 → 子代理正文/思考 → 工具调用 → 工具结果」。
 *
 * 转录由 server 边跑边写（每轮 provider 调用与每批工具结束后原子刷新），
 * 运行中由 SubagentThread 轮询；终态停止轮询并显示结论摘要与复制入口。
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
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  // 默认跟随正在运行的成员；没有运行中的则看第一项。用户手动选中后保持其选择。
  const fallbackRun = group?.runs.find((run) => run.status === "running") ?? group?.runs[0];
  const activeRun = group?.runs.find((run) => run.taskId === selectedTaskId) ?? fallbackRun;

  if (!group || !activeRun) {
    return (
      <p className="muted-empty panel-empty subagent-tab-empty">
        {t("该标签对应的子代理运行已不在记录中。", "The subagent runs for this tab are no longer recorded.")}
      </p>
    );
  }

  const done = group.runs.filter((run) => run.status === "done").length;
  const failed = group.runs.filter((run) => run.status === "failed").length;
  const running = group.runs.filter((run) => run.status === "running").length;
  // 本组实际生效模型（去重）：一眼看清这批子代理跑在哪个模型上
  const models = [...new Set(group.runs.map((run) => run.model).filter((model): model is string => Boolean(model)))];
  return (
    <div className="subagent-tab-view">
      <header className="subagents-group-header">
        {group.swarm
          ? t(
            `Swarm ${group.total} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
            `Swarm · ${group.total} items · ${done} done / ${failed} failed / ${running} running`,
          )
          : t(
            `子代理 ${group.runs.length} 项 · 完成 ${done} / 失败 ${failed} / 运行中 ${running}`,
            `Subagents · ${group.runs.length} items · ${done} done / ${failed} failed / ${running} running`,
          )}
        {models.map((model) => (
          <span key={model} className="subagent-run-model mono" title={model}>{model}</span>
        ))}
      </header>
      {group.runs.length > 1 && (
        <div className="subagent-run-tabs" role="tablist" aria-label={t("子代理运行", "Subagent runs")}>
          {group.runs.map((run, index) => {
            const selected = run.taskId === activeRun.taskId;
            const indexLabel = run.swarm ? `${run.swarm.index}/${run.swarm.total}` : `#${index + 1}`;
            return (
              <button
                key={run.taskId}
                type="button"
                role="tab"
                aria-selected={selected}
                className="subagent-run-tab"
                data-status={run.status}
                title={run.prompt}
                onClick={() => setSelectedTaskId(run.taskId)}
              >
                <span className="subagent-run-index mono">{indexLabel}</span>
                {run.agent && <span className="subagent-run-agent mono">{run.agent}</span>}
                <SubagentStatusChip status={run.status} />
              </button>
            );
          })}
        </div>
      )}
      <section className="subagent-thread-panel">
        <header className="subagent-thread-header">
          <span className="subagent-run-index mono">
            {activeRun.swarm ? `${activeRun.swarm.index}/${activeRun.swarm.total}` : `#${group.runs.indexOf(activeRun) + 1}`}
          </span>
          {activeRun.agent && <span className="subagent-run-agent mono">{activeRun.agent}</span>}
          {activeRun.role && <SubagentRoleBadge role={activeRun.role} />}
          {activeRun.model && <span className="subagent-run-model mono" title={activeRun.model}>{activeRun.model}</span>}
          <SubagentStatusChip status={activeRun.status} />
          <SubagentRunStats run={activeRun} />
        </header>
        <SubagentThread sessionId={sessionId} run={activeRun} />
      </section>
    </div>
  );
}
