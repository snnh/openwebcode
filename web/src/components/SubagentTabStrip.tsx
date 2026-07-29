import type { ReactElement } from "react";
import type { LiveSubagentRun } from "../lib/contracts";
import { snippet } from "../lib/subagent-runs";
import type { SubagentTab } from "../hooks/use-subagent-tabs";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";

export type SubagentTabStatus = "running" | "done" | "failed";

/** 标签状态指示：组内有运行中 → running（琥珀）；否则有失败 → failed（红）；全完成 → done（绿）；无运行记录 → undefined */
export function subagentTabStatus(runs: Record<string, LiveSubagentRun>, toolCallId: string): SubagentTabStatus | undefined {
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
 * 主区标签条（桌面端）：最左固定「主对话」标签 + 可选终端标签 + 每个 spawn 调用一个动态标签。
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
              {status === "running" && <span className="subagent-run-spinner subagent-tab-spinner" aria-hidden />}
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
