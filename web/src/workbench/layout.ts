import { createStore } from "../app/store";

/**
 * Workbench 布局偏好（旧 useWorkbenchLayout 的 store 化移植）：
 * 桌面偏好（视图/侧栏开合与宽度/底部面板）写穿 localStorage，沿用旧键名以保留用户偏好；
 * 移动端抽屉开合是会话态，不持久化。
 */

export type SidebarView = "sessions" | "files" | "scm" | "problems";

const SIDEBAR_VIEWS: readonly SidebarView[] = ["sessions", "files", "scm", "problems"];

/** 底部面板页签（Phase 2 接入 BottomPanel 时消费；此处仅负责持久化语义） */
export type BottomTab = "context" | "timeline" | "cost" | "subagents" | "sandbox" | "perf" | "eval";

const BOTTOM_TABS: readonly BottomTab[] = ["context", "timeline", "cost", "subagents", "sandbox", "perf", "eval"];

export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 380;
export const PANEL_MIN_HEIGHT = 140;
export const PANEL_MAX_HEIGHT = 600;

const clampRailWidth = (value: number): number => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, value));
const clampPanelHeight = (value: number): number => Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, value));

const VIEW_KEY = "owc-wb-view";
const WIDTH_KEY = "owc-rail-width";
const COLLAPSED_KEY = "owc-rail-collapsed";
const PANEL_OPEN_KEY = "owc-panel-open";
const PANEL_TAB_KEY = "owc-panel-tab";
const PANEL_HEIGHT_KEY = "owc-panel-height";

/** 重置布局时一并清理的键（设置对话框的 resetLayout 使用） */
export const LAYOUT_STORAGE_KEYS = [WIDTH_KEY, COLLAPSED_KEY, VIEW_KEY, PANEL_OPEN_KEY, PANEL_TAB_KEY, PANEL_HEIGHT_KEY] as const;

function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 持久化失败不影响使用
  }
}

export interface LayoutState {
  sidebarView: SidebarView;
  sidebarVisible: boolean;
  sidebarWidth: number;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  bottomHeight: number;
  /** 移动端左上角导航菜单（不持久化） */
  mobileNavOpen: boolean;
  /** 移动端侧栏抽屉（不持久化） */
  mobileSidebarOpen: boolean;
}

function loadSidebarView(): SidebarView {
  const stored = readStored(VIEW_KEY);
  return stored && (SIDEBAR_VIEWS as readonly string[]).includes(stored) ? (stored as SidebarView) : "sessions";
}

function loadBottomTab(): BottomTab {
  const stored = readStored(PANEL_TAB_KEY);
  return stored && (BOTTOM_TABS as readonly string[]).includes(stored) ? (stored as BottomTab) : "context";
}

const INITIAL_STATE: LayoutState = {
  sidebarView: loadSidebarView(),
  sidebarVisible: readStored(COLLAPSED_KEY) !== "1",
  sidebarWidth: clampRailWidth(Number(readStored(WIDTH_KEY)) || 250),
  bottomOpen: readStored(PANEL_OPEN_KEY) === "1",
  bottomTab: loadBottomTab(),
  bottomHeight: clampPanelHeight(Number(readStored(PANEL_HEIGHT_KEY)) || 260),
  mobileNavOpen: false,
  mobileSidebarOpen: false,
};

export const layoutStore = createStore<LayoutState>(INITIAL_STATE);

export const layout = {
  /** 点同一视图图标时折叠侧栏（VSCode 行为），否则切换视图并展开 */
  showView(view: SidebarView): void {
    const previous = layoutStore.get();
    if (previous.sidebarView === view) {
      const sidebarVisible = !previous.sidebarVisible;
      layoutStore.set({ sidebarVisible });
      writeStored(COLLAPSED_KEY, sidebarVisible ? "0" : "1");
      return;
    }
    layoutStore.set({ sidebarView: view, sidebarVisible: true });
    writeStored(VIEW_KEY, view);
    writeStored(COLLAPSED_KEY, "0");
  },
  /** 仅选择活动视图，不改变侧栏可见性（窄窗口临时抽屉使用） */
  selectView(view: SidebarView): void {
    if (layoutStore.get().sidebarView === view) return;
    layoutStore.set({ sidebarView: view });
    writeStored(VIEW_KEY, view);
  },
  toggleSidebar(): void {
    const sidebarVisible = !layoutStore.get().sidebarVisible;
    layoutStore.set({ sidebarVisible });
    writeStored(COLLAPSED_KEY, sidebarVisible ? "0" : "1");
  },
  /** 显式设置桌面侧栏可见性 */
  setSidebarVisible(visible: boolean): void {
    if (layoutStore.get().sidebarVisible === visible) return;
    layoutStore.set({ sidebarVisible: visible });
    writeStored(COLLAPSED_KEY, visible ? "0" : "1");
  },
  setSidebarWidth(width: number): void {
    const clamped = clampRailWidth(width);
    if (layoutStore.get().sidebarWidth === clamped) return;
    layoutStore.set({ sidebarWidth: clamped });
    writeStored(WIDTH_KEY, String(clamped));
  },
  setBottomOpen(open: boolean | ((previous: boolean) => boolean)): void {
    const next = typeof open === "function" ? open(layoutStore.get().bottomOpen) : open;
    if (layoutStore.get().bottomOpen === next) return;
    layoutStore.set({ bottomOpen: next });
    writeStored(PANEL_OPEN_KEY, next ? "1" : "0");
  },
  toggleBottomPanel(): void {
    layout.setBottomOpen((previous) => !previous);
  },
  setBottomTab(tab: BottomTab): void {
    if (layoutStore.get().bottomTab === tab) return;
    layoutStore.set({ bottomTab: tab });
    writeStored(PANEL_TAB_KEY, tab);
  },
  setBottomHeight(height: number): void {
    const clamped = clampPanelHeight(height);
    if (layoutStore.get().bottomHeight === clamped) return;
    layoutStore.set({ bottomHeight: clamped });
    writeStored(PANEL_HEIGHT_KEY, String(clamped));
  },
  setMobileNavOpen(open: boolean): void {
    layoutStore.set({ mobileNavOpen: open });
  },
  setMobileSidebarOpen(open: boolean): void {
    layoutStore.set({ mobileSidebarOpen: open });
  },
  /** 清除布局类 localStorage 键并重载（设置「通用」页签入口） */
  resetLayout(): void {
    for (const key of LAYOUT_STORAGE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
    window.location.reload();
  },
};
