import type { ReactElement } from "react";
import { useI18n } from "../i18n";

/** 会话打开加载骨架（0.7.x UX 批次）：详情查询进行中时替代欢迎页闪烁，纯 CSS 微光动画 */
export function SessionSkeleton(): ReactElement {
  const { t } = useI18n();
  return (
    <div className="session-skeleton" role="status" aria-label={t("正在加载会话", "Loading session")} data-testid="session-skeleton">
      {[0, 1, 2].map((item) => (
        <div className="skeleton-message" key={item} aria-hidden>
          <span className="skeleton-line skeleton-meta" />
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
  );
}
