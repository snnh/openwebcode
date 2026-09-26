import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { ReactElement } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Markdown } from "../components/Markdown";
import { crashRecords, clearCrashRecords, crashReport, installBootGuards } from "../lib/crash-log";

/** 渲染期抛错的组件：无边界时会卸载整棵树（白屏）。 */
function Boom(): ReactElement {
  throw new Error("boom in render");
}

/** 生命周期抛错：与渲染期抛错同样会卸载整棵树。 */
function EffectBoom(): ReactElement {
  useEffect(() => {
    throw new Error("boom in effect");
  }, []);
  return <div>不该出现</div>;
}

describe("ErrorBoundary 兜底（白屏护栏）", () => {
  it("渲染期抛错显示兜底卡片而非白屏，重试后复位；错误记入崩溃环形缓冲", () => {
    clearCrashRecords();
    const view = render(
      <ErrorBoundary label="测试区">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/测试区渲染失败/)).toBeInTheDocument();
    expect(screen.getByText(/boom in render/)).toBeInTheDocument();
    expect(crashRecords().some((record) => record.message === "boom in render")).toBe(true);
    // 「重试」在仍然抛错时回到同一兜底（不无限循环、不白屏）
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    view.unmount();
  });

  it("useEffect 抛错同样被兜底接住", () => {
    clearCrashRecords();
    render(
      <ErrorBoundary label="效果区">
        <EffectBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(crashRecords().some((record) => record.message === "boom in effect")).toBe(true);
  });

  it("resetKey 变化后自动复位（切会话/切路由不再停在旧错误上）", () => {
    clearCrashRecords();
    const view = render(
      <ErrorBoundary label="复位区" resetKey="a">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    view.rerender(
      <ErrorBoundary label="复位区" resetKey="b">
        <div>恢复内容</div>
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("恢复内容")).toBeInTheDocument();
  });

  it("自定义 fallback 生效（Markdown 走纯文本降级，内容不丢）", () => {
    const view = render(
      <ErrorBoundary label="Markdown" fallback={() => <pre>降级文本</pre>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("降级文本")).toBeInTheDocument();
    view.unmount();
  });
});

describe("崩溃记录与启动兜底钩子", () => {
  it("installBootGuards 吞掉 vite:preloadError 并记录分块失败（不再抛给 React）", () => {
    clearCrashRecords();
    installBootGuards();
    const event = new Event("vite:preloadError", { cancelable: true });
    Object.assign(event, { payload: new Error("Failed to fetch dynamically imported module") });
    expect(() => window.dispatchEvent(event)).not.toThrow();
    const [record] = crashRecords();
    expect(record?.kind).toBe("chunk");
    expect(record?.message).toContain("dynamically imported module");
    expect(event.defaultPrevented).toBe(true);
  });

  it("未捕获 promise 拒绝只记录，不影响页面", () => {
    clearCrashRecords();
    installBootGuards();
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("later failure");
    window.dispatchEvent(event);
    expect(crashRecords()[0]?.kind).toBe("unhandledrejection");
  });

  it("诊断报告含 url/ua 与已记录的错误，不含未记录内容", () => {
    clearCrashRecords();
    const report = crashReport();
    expect(report).toContain("url:");
    expect(report).not.toContain("boom in render");
  });
});

describe("Markdown 外包一层边界后仍正常渲染", () => {
  it("分块加载完成后照常渲染（边界不改变正常路径）", async () => {
    render(<Markdown>{"# 标题\n\n正文"}</Markdown>);
    expect(await screen.findByText("正文")).toBeInTheDocument();
  });
});
