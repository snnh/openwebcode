// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * iOS 软键盘适配（app/visual-viewport.ts）：
 * 键盘弹出 → --vvh 写入真实可视高度；地址栏动画（遮挡≈0）与捏合缩放（scale>1）不触发；
 * 键盘收起 → 变量移除，外壳回退 100dvh。
 * installed 是模块级单例，每个用例 resetModules + 动态 import 隔离。
 */

interface MockViewport {
  set(patch: Partial<{ height: number; offsetTop: number; scale: number }>): void;
  fire(type: "resize" | "scroll"): void;
}

function mockViewport(initial?: Partial<{ height: number; offsetTop: number; scale: number }>): MockViewport {
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    height: 800,
    offsetTop: 0,
    scale: 1,
    ...initial,
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  return {
    set: (patch) => Object.assign(viewport, patch),
    fire: (type) => { for (const fn of listeners.get(type) ?? []) fn(); },
  };
}

function setInnerHeight(value: number): void {
  Object.defineProperty(window, "innerHeight", { value, configurable: true, writable: true });
}

async function install(): Promise<void> {
  const module = await import("../app/visual-viewport");
  module.installVisualViewportHeight();
}

afterEach(() => {
  vi.resetModules();
  document.documentElement.style.removeProperty("--vvh");
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
  setInnerHeight(768);
});

describe("installVisualViewportHeight", () => {
  it("无 visualViewport（旧浏览器/桌面）静默不装", async () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    await expect(install()).resolves.toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
  });

  it("键盘弹出（底部遮挡 > 阈值）写入 --vvh 为可视高度", async () => {
    setInnerHeight(800);
    const viewport = mockViewport({ height: 800 });
    await install();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
    viewport.set({ height: 460 }); // 键盘占 340px
    viewport.fire("resize");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("460px");
  });

  it("地址栏收起/展开（遮挡 ≈ 0，innerHeight 同步变）不接管", async () => {
    setInnerHeight(800);
    const viewport = mockViewport({ height: 740 }); // 遮挡 60px < 120 阈值
    await install();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
    setInnerHeight(860);
    viewport.set({ height: 800 });
    viewport.fire("resize");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
  });

  it("捏合缩放（scale > 1）时即使遮挡超阈值也不接管", async () => {
    setInnerHeight(800);
    const viewport = mockViewport({ height: 800 });
    await install();
    viewport.set({ height: 400, scale: 2 });
    viewport.fire("resize");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
  });

  it("键盘收起后移除 --vvh（回退 100dvh）；offsetTop 计入遮挡", async () => {
    setInnerHeight(800);
    const viewport = mockViewport({ height: 800 });
    await install();
    // 键盘弹出且页面被推移：height 460 + offsetTop 40 → 遮挡 300
    viewport.set({ height: 460, offsetTop: 40 });
    viewport.fire("scroll");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("460px");
    viewport.set({ height: 800, offsetTop: 0 });
    viewport.fire("resize");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
  });

  it("重复安装幂等（只挂一次监听）", async () => {
    setInnerHeight(800);
    const viewport = mockViewport({ height: 800 });
    const module = await import("../app/visual-viewport");
    module.installVisualViewportHeight();
    module.installVisualViewportHeight();
    viewport.set({ height: 460 });
    viewport.fire("resize");
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("460px");
  });
});
