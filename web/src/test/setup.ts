import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor 默认 1000ms 超时在并行跑满 CPU（Windows 构建机）时偶发超时，
// 被测代码本身是同步渲染、无真实时序问题；放宽到 3s 消除负载抖动，不掩盖逻辑错误。
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
});
