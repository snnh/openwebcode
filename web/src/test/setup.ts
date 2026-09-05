import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";

// Node 运行器未提供 localStorage 时补齐最小实现，保持组件测试与浏览器语义一致。
if (typeof window !== "undefined" && !window.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } satisfies Storage });
}

// findBy*/waitFor 默认 1000ms 超时在并行跑满 CPU（Windows 构建机）时偶发超时，
// 被测代码本身是同步渲染、无真实时序问题；放宽到 3s 消除负载抖动，不掩盖逻辑错误。
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
});

// jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：全局打桩为 open 属性开关
//（此前各测试文件各自 beforeEach 打桩，此处幂等统一；直接赋值，不受 vi.restoreAllMocks 影响）
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };

// jsdom 不实现 scrollIntoView（@/skill 弹层键盘导航滚动会调用）：幂等空实现
Element.prototype.scrollIntoView = function scrollIntoView() { /* noop */ };
