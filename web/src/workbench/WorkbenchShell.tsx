/**
 * 五区 Workbench 布局壳（0.4.0 Phase 5a）：活动栏 / 侧边栏 / 主区 / 底部面板 / 状态栏。
 * 只负责栅格与 F6 区域焦点轮换；各区内容由 App 以插槽传入。
 * 窄屏（≤1024px）布局由 styles.css 媒体查询接管：flex 单列、桌面活动栏隐藏
 * （导航改由左上角 logo 触发的左侧滑出菜单承担）、侧栏变抽屉、编辑器/diff 变全屏
 * 临时视图——DOM 结构与桌面一致，此处不加分支。
 */
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useI18n } from "../i18n";

/** 焦点轮换事件：cycleZone 命令分发 CustomEvent，壳组件监听，保持命令层与布局解耦 */
export const CYCLE_ZONE_EVENT = "owc:cycle-zone";

const ZONE_ORDER = ["activity", "sidebar", "main", "bottom"] as const;

function focusZone(root: HTMLElement, zone: string): void {
  const element = root.querySelector<HTMLElement>(`[data-wb-zone="${zone}"]`);
  if (!element) return;
  const focusable = element.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  (focusable ?? element).focus();
}

export function WorkbenchShell({ activityBar, sidebar, sidebarWidth, main, bottom, statusBar }: {
  activityBar: ReactNode;
  /** undefined 表示侧栏隐藏 */
  sidebar?: ReactNode;
  sidebarWidth?: number;
  main: ReactNode;
  bottom: ReactNode;
  statusBar: ReactNode;
}): ReactElement {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);

  const cycleZone = useCallback((): void => {
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    const currentZone = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-wb-zone]")?.dataset.wbZone : undefined;
    const available = ZONE_ORDER.filter((zone) => root.querySelector(`[data-wb-zone="${zone}"]`));
    if (available.length === 0) return;
    const index = currentZone ? available.indexOf(currentZone as (typeof ZONE_ORDER)[number]) : -1;
    focusZone(root, available[(index + 1) % available.length]);
  }, []);

  useEffect(() => {
    window.addEventListener(CYCLE_ZONE_EVENT, cycleZone);
    return () => window.removeEventListener(CYCLE_ZONE_EVENT, cycleZone);
  }, [cycleZone]);

  return (
    <div
      ref={rootRef}
      className="console-shell wb-shell"
      style={{ gridTemplateColumns: sidebar ? `48px ${sidebarWidth ?? 250}px minmax(0, 1fr)` : "48px minmax(0, 1fr)" }}
    >
      <div className="wb-zone wb-activity" data-wb-zone="activity" tabIndex={-1} role="navigation" aria-label={t("活动栏", "Activity Bar")}>
        {activityBar}
      </div>
      {sidebar !== undefined && (
        <div className="wb-zone wb-sidebar" data-wb-zone="sidebar" tabIndex={-1} role="complementary" aria-label={t("侧边栏", "Sidebar")}>
          {sidebar}
        </div>
      )}
      <div className="wb-zone wb-main" data-wb-zone="main" tabIndex={-1} role="main" aria-label={t("对话", "Conversation")}>
        {main}
      </div>
      <div className="wb-zone wb-bottom" data-wb-zone="bottom" tabIndex={-1} role="complementary" aria-label={t("面板", "Panel")}>
        {bottom}
      </div>
      <div className="wb-status">
        {statusBar}
      </div>
    </div>
  );
}
