import { lazy, Suspense, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
import { Icon, type IconName } from "./Icon";

// 五个面板各自独立 chunk，仅在打开对应标签页时加载
const ContextPanel = lazy(() => import("./panels/ContextPanel").then((m) => ({ default: m.ContextPanel })));
const CostPanel = lazy(() => import("./panels/CostPanel").then((m) => ({ default: m.CostPanel })));
const FilesPanel = lazy(() => import("./panels/FilesPanel").then((m) => ({ default: m.FilesPanel })));
const SandboxPanel = lazy(() => import("./panels/SandboxPanel").then((m) => ({ default: m.SandboxPanel })));
const TimelinePanel = lazy(() => import("./panels/TimelinePanel").then((m) => ({ default: m.TimelinePanel })));
import { useI18n } from "../i18n";

export type PanelTab = "files" | "context" | "timeline" | "sandbox" | "cost";

const TAB_META: Record<PanelTab, { zh: string; en: string; icon: IconName }> = {
  files: { zh: "文件", en: "Files", icon: "folder" },
  context: { zh: "上下文", en: "Context", icon: "layers" },
  timeline: { zh: "时间线", en: "Timeline", icon: "history" },
  sandbox: { zh: "沙盒", en: "Sandbox", icon: "shield" },
  cost: { zh: "成本", en: "Cost", icon: "chart" },
};

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;

const clampHeight = (value: number): number => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value));

function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响使用
  }
}

export function BottomPanel({ sessionId, session, running, onNotice }: {
  sessionId?: string;
  session?: SessionDetail;
  running: boolean;
  onNotice(message: string, kind?: "info" | "error"): void;
}): ReactElement {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanelTab>(() => {
    const stored = readStored("owc-panel-tab");
    return stored && stored in TAB_META ? (stored as PanelTab) : "files";
  });
  const [open, setOpen] = useState(() => readStored("owc-panel-open") === "1");
  const [height, setHeight] = useState(() => clampHeight(Number(readStored("owc-panel-height")) || 260));

  useEffect(() => store("owc-panel-tab", tab), [tab]);
  useEffect(() => store("owc-panel-open", open ? "1" : "0"), [open]);
  useEffect(() => store("owc-panel-height", String(height)), [height]);

  // 顶部拖拽调高：向上拖增大高度；键盘 ArrowUp/Down 每次 40px
  const startDrag = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (move: MouseEvent): void => setHeight(clampHeight(startHeight + (startY - move.clientY)));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selectTab = (item: PanelTab): void => {
    if (item === tab) setOpen((value) => !value);
    else {
      setTab(item);
      setOpen(true);
    }
  };

  return (
    <section className={`bottom-panel${open ? " open" : ""}`} aria-label={t("面板", "Panel")}>
      {open && (
        <button
          className="panel-resize"
          aria-label={t("调整面板高度（方向键上下）", "Resize panel (use arrow keys)")}
          onMouseDown={startDrag}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") setHeight((value) => clampHeight(value + 40));
            if (event.key === "ArrowDown") setHeight((value) => clampHeight(value - 40));
          }}
        />
      )}
      <div className="panel-tabs">
        {(Object.keys(TAB_META) as PanelTab[]).map((item) => (
          <button
            key={item}
            className={tab === item && open ? "active" : ""}
            aria-pressed={tab === item && open}
            onClick={() => selectTab(item)}
          >
            <Icon name={TAB_META[item].icon} size={13} />
            {t(TAB_META[item].zh, TAB_META[item].en)}
          </button>
        ))}
        <button
          className="panel-fold"
          aria-label={open ? t("收起面板", "Collapse panel") : t("展开面板", "Expand panel")}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "chevron-down" : "chevron-up"} size={14} />
        </button>
      </div>
      {open && (
        <div className="panel-content" style={{ height }}>
          <Suspense fallback={null}>
          {tab === "files" && <FilesPanel sessionId={sessionId} session={session} running={running} onNotice={onNotice} />}
          {tab === "context" && <ContextPanel sessionId={sessionId} session={session} running={running} onNotice={onNotice} />}
          {tab === "timeline" && <TimelinePanel sessionId={sessionId} running={running} onNotice={onNotice} />}
          {tab === "sandbox" && <SandboxPanel session={session} />}
          {tab === "cost" && <CostPanel />}
          </Suspense>
        </div>
      )}
    </section>
  );
}
