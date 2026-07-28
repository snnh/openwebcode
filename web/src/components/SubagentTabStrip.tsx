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
 * 主区标签条（桌面端）：最左固定「对话」标签 + 每个 spawn 调用一个动态标签。
 * 运行中且未选中的标签用琥珀色吸引注意；关闭标签只影响视图，不影响子代理运行。
 */
export function SubagentTabStrip({ tabs, runs, selected, onSelect, onClose }: {
  /** 当前会话的子代理标签（toolCallId 键控，按创建顺序） */
  tabs: SubagentTab[];
  /** 当前会话合并后的子代理运行（状态指示用） */
  runs: Record<string, LiveSubagentRun>;
  /** 选中标签的 toolCallId；undefined 表示「对话」 */
  selected: string | undefined;
  onSelect(toolCallId?: string): void;
  onClose(toolCallId: string): void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <div className="subagent-tabs" role="tablist" aria-label={t("主区标签", "Main tabs")}>
      <button
        type="button"
        role="tab"
        aria-selected={selected === undefined}
        className="subagent-tab-main"
        onClick={() => onSelect(undefined)}
      >
        {t("对话", "Chat")}
      </button>
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
