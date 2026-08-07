import { useEffect, useState, type ReactElement } from "react";
import { formatDuration } from "../../lib/format";
import { INACTIVE_STATES, stateLabel } from "../../lib/agent-state";
import { useI18n } from "../../i18n";
import type { LiveActivityBarProps } from "../types";

/**
 * 实时活动条：旋转指示 + 运行状态标签 + 每秒跳动的已耗时 + 当前工具 chip。
 * 文档流内占位（不再 sticky 覆盖消息）；空闲/终态时不渲染（返回 null）。
 */
export function LiveActivityBar({ activity }: LiveActivityBarProps): ReactElement | null {
  const { t } = useI18n();
  const running = activity.state !== undefined && !INACTIVE_STATES.has(activity.state);
  // 已耗时每秒跳动：仅在运行时挂定时器
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!running) return null;
  const elapsed = activity.since !== undefined ? Math.max(0, Date.now() - activity.since) : undefined;
  return (
    <div className="live-activity" role="status">
      <span className="live-activity-spinner" aria-hidden />
      <span className="live-activity-label">{t(...stateLabel(activity.state!))}</span>
      {elapsed !== undefined && <span className="live-activity-elapsed">{formatDuration(elapsed)}</span>}
      {activity.currentTool && (
        <span className="live-activity-tool">
          {activity.toolCount > 1
            ? t(`${activity.currentTool} 等 ${activity.toolCount} 项`, `${activity.currentTool} +${activity.toolCount - 1} more`)
            : activity.currentTool}
        </span>
      )}
    </div>
  );
}
