import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  loadBottomOpen,
  loadSidebarView,
  loadSidebarVisible,
  loadSidebarWidth,
  useWorkbenchLayout,
} from "../workbench/useWorkbenchLayout";

beforeEach(() => window.localStorage.clear());

describe("布局持久化读取", () => {
  it("默认值：会话视图、侧栏展开 250、底部面板收起", () => {
    expect(loadSidebarView()).toBe("sessions");
    expect(loadSidebarVisible()).toBe(true);
    expect(loadSidebarWidth()).toBe(250);
    expect(loadBottomOpen()).toBe(false);
  });

  it("读取已存值并钳制非法值", () => {
    window.localStorage.setItem("owc-wb-view", "scm");
    window.localStorage.setItem("owc-rail-collapsed", "1");
    window.localStorage.setItem("owc-rail-width", "9999");
    window.localStorage.setItem("owc-panel-open", "1");
    expect(loadSidebarView()).toBe("scm");
    expect(loadSidebarVisible()).toBe(false);
    expect(loadSidebarWidth()).toBe(380); // clampRailWidth 上限
    expect(loadBottomOpen()).toBe(true);
  });

  it("未知视图名回退 sessions", () => {
    window.localStorage.setItem("owc-wb-view", "bogus");
    expect(loadSidebarView()).toBe("sessions");
  });
});

describe("useWorkbenchLayout", () => {
  it("showView 切换视图并展开；重复点同一视图折叠侧栏", () => {
    const { result } = renderHook(() => useWorkbenchLayout());
    act(() => result.current.showView("files"));
    expect(result.current.sidebarView).toBe("files");
    expect(result.current.sidebarVisible).toBe(true);
    act(() => result.current.showView("files"));
    expect(result.current.sidebarVisible).toBe(false);
    expect(window.localStorage.getItem("owc-wb-view")).toBe("files");
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");
  });

  it("selectView 只切换视图，不展开已折叠的桌面侧栏", () => {
    window.localStorage.setItem("owc-rail-collapsed", "1");
    const { result } = renderHook(() => useWorkbenchLayout());
    expect(result.current.sidebarVisible).toBe(false);

    act(() => result.current.selectView("files"));

    expect(result.current.sidebarView).toBe("files");
    expect(result.current.sidebarVisible).toBe(false);
    expect(window.localStorage.getItem("owc-wb-view")).toBe("files");
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");
  });

  it("toggleSidebar / toggleBottomPanel 写入 localStorage", () => {
    const { result } = renderHook(() => useWorkbenchLayout());
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.toggleBottomPanel());
    expect(result.current.bottomOpen).toBe(true);
    expect(window.localStorage.getItem("owc-panel-open")).toBe("1");
  });

  it("setSidebarWidth 钳制并持久化", () => {
    const { result } = renderHook(() => useWorkbenchLayout());
    act(() => result.current.setSidebarWidth(10));
    expect(result.current.sidebarWidth).toBe(200);
    expect(window.localStorage.getItem("owc-rail-width")).toBe("200");
  });

  it("从既有存储恢复（沿用 0.3.x 键名）", () => {
    window.localStorage.setItem("owc-rail-width", "300");
    window.localStorage.setItem("owc-panel-open", "1");
    const { result } = renderHook(() => useWorkbenchLayout());
    expect(result.current.sidebarWidth).toBe(300);
    expect(result.current.bottomOpen).toBe(true);
  });
});
