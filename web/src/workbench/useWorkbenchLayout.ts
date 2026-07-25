/**
 * Workbench 布局状态与持久化（0.4.0 Phase 5a）。
 * 沿用现有 localStorage 模式与键名（侧栏宽度/折叠、底部面板开合沿用
 * 0.3.x 的 owc-rail-* / owc-panel-* 键，避免迁移），新增 owc-wb-view 记录活动视图。
 */
import { useCallback, useEffect, useState } from "react";
import { clampRailWidth } from "../components/SessionRail";

export type SidebarView = "sessions" | "files" | "scm" | "problems";

export const SIDEBAR_VIEWS: readonly SidebarView[] = ["sessions", "files", "scm", "problems"];

const VIEW_KEY = "owc-wb-view";
const WIDTH_KEY = "owc-rail-width";
const COLLAPSED_KEY = "owc-rail-collapsed";
const PANEL_OPEN_KEY = "owc-panel-open";

/** 重置布局时一并清理的键（SettingsDialog 的 resetLayout 使用） */
export const LAYOUT_STORAGE_KEYS = [WIDTH_KEY, COLLAPSED_KEY, VIEW_KEY, PANEL_OPEN_KEY, "owc-panel-tab", "owc-panel-height"] as const;

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

export function loadSidebarView(): SidebarView {
  const stored = readStored(VIEW_KEY);
  return stored && (SIDEBAR_VIEWS as readonly string[]).includes(stored) ? (stored as SidebarView) : "sessions";
}

export function loadSidebarWidth(): number {
  return clampRailWidth(Number(readStored(WIDTH_KEY)) || 250);
}

export function loadSidebarVisible(): boolean {
  return readStored(COLLAPSED_KEY) !== "1";
}

export function loadBottomOpen(): boolean {
  return readStored(PANEL_OPEN_KEY) === "1";
}

export interface WorkbenchLayoutState {
  sidebarView: SidebarView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  bottomOpen: boolean;
  /** 点同一视图图标时折叠侧栏（VSCode 行为），否则切换视图并展开 */
  showView(view: SidebarView): void;
  toggleSidebar(): void;
  /** 显式设置侧栏可见性（移动端抽屉：选中会话后收起） */
  setSidebarVisible(visible: boolean): void;
  setSidebarWidth(width: number): void;
  setBottomOpen(open: boolean | ((previous: boolean) => boolean)): void;
  toggleBottomPanel(): void;
}

export function useWorkbenchLayout(): WorkbenchLayoutState {
  const [sidebarView, setSidebarView] = useState<SidebarView>(loadSidebarView);
  const [sidebarVisible, setSidebarVisible] = useState(loadSidebarVisible);
  const [sidebarWidth, setSidebarWidthState] = useState(loadSidebarWidth);
  const [bottomOpen, setBottomOpen] = useState(loadBottomOpen);

  useEffect(() => store(VIEW_KEY, sidebarView), [sidebarView]);
  useEffect(() => store(COLLAPSED_KEY, sidebarVisible ? "0" : "1"), [sidebarVisible]);
  useEffect(() => store(WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => store(PANEL_OPEN_KEY, bottomOpen ? "1" : "0"), [bottomOpen]);

  const showView = useCallback((view: SidebarView): void => {
    setSidebarView((previous) => {
      if (previous === view) {
        setSidebarVisible((visible) => !visible);
        return previous;
      }
      setSidebarVisible(true);
      return view;
    });
  }, []);
  const toggleSidebar = useCallback((): void => setSidebarVisible((value) => !value), []);
  const setSidebarWidth = useCallback((width: number): void => setSidebarWidthState(clampRailWidth(width)), []);
  const toggleBottomPanel = useCallback((): void => setBottomOpen((value) => !value), []);

  return { sidebarView, sidebarVisible, sidebarWidth, bottomOpen, showView, toggleSidebar, setSidebarVisible, setSidebarWidth, setBottomOpen, toggleBottomPanel };
}
