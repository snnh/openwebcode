import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { SessionDetail } from "../lib/contracts";
import { Icon, type IconName } from "./Icon";
import { ContextPanel } from "./panels/ContextPanel";
import { CostPanel } from "./panels/CostPanel";
import { FilesPanel } from "./panels/FilesPanel";
import { SandboxPanel } from "./panels/SandboxPanel";
import { TimelinePanel } from "./panels/TimelinePanel";

export type PanelTab = "files" | "context" | "timeline" | "sandbox" | "cost";

const TAB_META: Record<PanelTab, { label: string; icon: IconName }> = {
  files: { label: "文件", icon: "folder" },
  context: { label: "上下文", icon: "layers" },
  timeline: { label: "时间线", icon: "history" },
  sandbox: { label: "沙盒", icon: "shield" },
  cost: { label: "成本", icon: "chart" },
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
  onNotice(message: string): void;
}): ReactElement {
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
    <section className={`bottom-panel${open ? " open" : ""}`} aria-label="面板">
      {open && (
        <button
          className="panel-resize"
          aria-label="调整面板高度（方向键上下）"
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
            {TAB_META[item].label}
          </button>
        ))}
        <button
          className="panel-fold"
          aria-label={open ? "收起面板" : "展开面板"}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "chevron-down" : "chevron-up"} size={14} />
        </button>
      </div>
      {open && (
        <div className="panel-content" style={{ height }}>
          {tab === "files" && <FilesPanel sessionId={sessionId} />}
          {tab === "context" && <ContextPanel sessionId={sessionId} session={session} running={running} onNotice={onNotice} />}
          {tab === "timeline" && <TimelinePanel sessionId={sessionId} running={running} onNotice={onNotice} />}
          {tab === "sandbox" && <SandboxPanel session={session} />}
          {tab === "cost" && <CostPanel />}
        </div>
      )}
    </section>
  );
}
