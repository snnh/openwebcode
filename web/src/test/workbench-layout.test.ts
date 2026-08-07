import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_STORAGE_KEYS, layout, layoutStore, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, PANEL_MAX_HEIGHT, PANEL_MIN_HEIGHT } from "../workbench/layout";

const DEFAULTS = {
  sidebarView: "sessions",
  sidebarVisible: true,
  sidebarWidth: 250,
  bottomOpen: false,
  bottomTab: "context",
  bottomHeight: 260,
  mobileNavOpen: false,
  mobileSidebarOpen: false,
} as const;

beforeEach(() => {
  window.localStorage.clear();
  layoutStore.set({ ...DEFAULTS });
});

describe("workbench/layout", () => {
  it("localStorage 键名沿用旧布局偏好键", () => {
    expect([...LAYOUT_STORAGE_KEYS]).toEqual([
      "owc-rail-width",
      "owc-rail-collapsed",
      "owc-wb-view",
      "owc-panel-open",
      "owc-panel-tab",
      "owc-panel-height",
    ]);
  });

  it("showView：点同一视图折叠/展开侧栏（VSCode 行为），切换视图则展开", () => {
    layout.showView("files");
    expect(layoutStore.get().sidebarView).toBe("files");
    expect(layoutStore.get().sidebarVisible).toBe(true);
    expect(window.localStorage.getItem("owc-wb-view")).toBe("files");
    // 同一视图再点 → 折叠
    layout.showView("files");
    expect(layoutStore.get().sidebarVisible).toBe(false);
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");
    // 再点 → 展开
    layout.showView("files");
    expect(layoutStore.get().sidebarVisible).toBe(true);
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("0");
    // 折叠状态下切到别的视图 → 展开
    layout.showView("files");
    layout.showView("scm");
    expect(layoutStore.get().sidebarView).toBe("scm");
    expect(layoutStore.get().sidebarVisible).toBe(true);
  });

  it("selectView：仅切换视图，不改变侧栏可见性", () => {
    layoutStore.set({ sidebarVisible: false });
    layout.selectView("problems");
    expect(layoutStore.get().sidebarView).toBe("problems");
    expect(layoutStore.get().sidebarVisible).toBe(false);
    expect(window.localStorage.getItem("owc-wb-view")).toBe("problems");
  });

  it("toggleSidebar / setSidebarVisible 持久化折叠态", () => {
    layout.toggleSidebar();
    expect(layoutStore.get().sidebarVisible).toBe(false);
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");
    layout.setSidebarVisible(true);
    expect(layoutStore.get().sidebarVisible).toBe(true);
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("0");
  });

  it("setSidebarWidth 夹取范围并持久化", () => {
    layout.setSidebarWidth(100);
    expect(layoutStore.get().sidebarWidth).toBe(RAIL_MIN_WIDTH);
    layout.setSidebarWidth(9999);
    expect(layoutStore.get().sidebarWidth).toBe(RAIL_MAX_WIDTH);
    expect(window.localStorage.getItem("owc-rail-width")).toBe(String(RAIL_MAX_WIDTH));
    layout.setSidebarWidth(300);
    expect(window.localStorage.getItem("owc-rail-width")).toBe("300");
  });

  it("setBottomOpen 支持值与函数更新；toggleBottomPanel 翻转", () => {
    layout.setBottomOpen(true);
    expect(layoutStore.get().bottomOpen).toBe(true);
    expect(window.localStorage.getItem("owc-panel-open")).toBe("1");
    layout.setBottomOpen((previous) => !previous);
    expect(layoutStore.get().bottomOpen).toBe(false);
    expect(window.localStorage.getItem("owc-panel-open")).toBe("0");
    layout.toggleBottomPanel();
    expect(layoutStore.get().bottomOpen).toBe(true);
  });

  it("setBottomTab / setBottomHeight 持久化（高度夹取范围）", () => {
    layout.setBottomTab("timeline");
    expect(layoutStore.get().bottomTab).toBe("timeline");
    expect(window.localStorage.getItem("owc-panel-tab")).toBe("timeline");
    layout.setBottomHeight(10);
    expect(layoutStore.get().bottomHeight).toBe(PANEL_MIN_HEIGHT);
    layout.setBottomHeight(99999);
    expect(layoutStore.get().bottomHeight).toBe(PANEL_MAX_HEIGHT);
    expect(window.localStorage.getItem("owc-panel-height")).toBe(String(PANEL_MAX_HEIGHT));
  });

  it("移动端抽屉/导航开合不持久化", () => {
    layout.setMobileNavOpen(true);
    layout.setMobileSidebarOpen(true);
    expect(layoutStore.get().mobileNavOpen).toBe(true);
    expect(layoutStore.get().mobileSidebarOpen).toBe(true);
    expect(window.localStorage.length).toBe(0);
  });

  it("模块加载时从 localStorage 读取既有偏好（旧键名兼容）", async () => {
    window.localStorage.setItem("owc-wb-view", "scm");
    window.localStorage.setItem("owc-rail-collapsed", "1");
    window.localStorage.setItem("owc-rail-width", "320");
    window.localStorage.setItem("owc-panel-open", "1");
    vi.resetModules();
    const fresh = await import("../workbench/layout");
    const state = fresh.layoutStore.get();
    expect(state.sidebarView).toBe("scm");
    expect(state.sidebarVisible).toBe(false);
    expect(state.sidebarWidth).toBe(320);
    expect(state.bottomOpen).toBe(true);
  });
});
