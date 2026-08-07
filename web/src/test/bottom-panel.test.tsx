import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "../workbench/BottomPanel";
import { api } from "../lib/api";
import type { ExtensionInfo } from "../lib/contracts";
import { layoutStore } from "../workbench/layout";
import { sessionMeta, sessionStore } from "../app/session-store";
import { makeContextView, makeModelProfile, makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const session = makeSession();

function evalExtension(enabled: boolean): ExtensionInfo {
  return { id: "owc-eval", enabled } as ExtensionInfo;
}

function mockBaseApis(extensions: ExtensionInfo[] = []): void {
  vi.spyOn(api, "extensions").mockResolvedValue(extensions);
  vi.spyOn(api, "sessions").mockResolvedValue([session]);
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "models").mockResolvedValue([makeModelProfile()]);
  vi.spyOn(api, "context").mockResolvedValue(makeContextView());
}

beforeEach(() => {
  window.localStorage.clear();
  layoutStore.set({ bottomOpen: false, bottomTab: "context", bottomHeight: 260 });
  sessionStore.set({ watermarks: {}, usages: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BottomPanel 页签与开合", () => {
  it("渲染页签条；eval 扩展未启用时不显示评测页签，启用后显示", async () => {
    mockBaseApis();
    const view = renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(screen.getByRole("button", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "子代理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "沙盒" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "性能" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "评测" })).toBeNull();
    view.unmount();

    mockBaseApis([evalExtension(true)]);
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(await screen.findByRole("button", { name: "评测" })).toBeInTheDocument();
  });

  it("点页签打开面板并加载对应内容；再点同页签收起", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    expect(layoutStore.get().bottomOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
    // 上下文面板内容（异步 lazy + 查询）出现
    expect(await screen.findByText("上下文用量")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "上下文" }));
    expect(layoutStore.get().bottomOpen).toBe(false);
  });

  it("切换页签保持展开；折叠按钮开合面板", async () => {
    mockBaseApis();
    vi.spyOn(api, "costReport").mockResolvedValue({
      preferences: { currency: "CNY" },
      totals: { runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      days: [],
      sessions: [],
    } as never);
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);

    fireEvent.click(screen.getByRole("button", { name: "成本" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
    expect(layoutStore.get().bottomTab).toBe("cost");
    expect(await screen.findByText(/所选范围内还没有模型调用记录/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(layoutStore.get().bottomOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "展开面板" }));
    expect(layoutStore.get().bottomOpen).toBe(true);
  });

  it("eval 页签选中后扩展被禁用，自动回退到上下文页签", async () => {
    mockBaseApis();
    layoutStore.set({ bottomTab: "eval" });
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    await waitFor(() => expect(layoutStore.get().bottomTab).toBe("context"));
  });

  it("拖拽柄键盘 ArrowUp/Down 调整面板高度", async () => {
    mockBaseApis();
    layoutStore.set({ bottomOpen: true });
    renderWithClient(<BottomPanel sessionId={session.id} mobile={false} />);
    const resize = screen.getByRole("button", { name: /调整面板高度/ });
    fireEvent.keyDown(resize, { key: "ArrowUp" });
    expect(layoutStore.get().bottomHeight).toBe(300);
    fireEvent.keyDown(resize, { key: "ArrowDown" });
    expect(layoutStore.get().bottomHeight).toBe(260);
  });
});

describe("BottomPanel 状态项", () => {
  it("桌面端：状态点+文案、tokens·成本、窗口占用 %", async () => {
    mockBaseApis();
    sessionMeta.setUsage(session.id, { inputTokens: 1_200, outputTokens: 80, cacheRead: 0, cacheWrite: 0 });
    sessionMeta.setWatermark(session.id, {
      estimatedTokens: 45_000,
      contextWindow: 128_000,
      maxOutput: 8_000,
      workingBudget: 120_000,
      utilization: 0.375,
      segments: { system: 0, compactionSummary: 0, toolResults: 0, messages: 45_000, repoMap: 0, other: 0 },
      pinnedTokens: 0,
      buildMs: 1,
      incremental: true,
    });
    renderWithClient(<BottomPanel sessionId={session.id} agentState="streaming" mobile={false} />);
    const status = screen.getByLabelText("会话状态");
    expect(status).toHaveTextContent("正在输出");
    await waitFor(() => expect(status).toHaveTextContent("1.3k tok"));
    expect(status).toHaveTextContent("窗口 38%");
  });

  it("空闲态显示空闲；无会话时不渲染状态项", () => {
    mockBaseApis();
    renderWithClient(<BottomPanel mobile={false} />);
    expect(screen.queryByLabelText("会话状态")).toBeNull();
  });
});

describe("BottomPanel 移动端", () => {
  it("常驻三个页签，其余收进第二行；展开后可点选", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} mobile={true} />);
    expect(screen.getByRole("button", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成本" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "子代理" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多面板标签" }));
    const subagents = await screen.findByRole("button", { name: "子代理" });
    fireEvent.click(subagents);
    expect(layoutStore.get().bottomTab).toBe("subagents");
    expect(layoutStore.get().bottomOpen).toBe(true);
  });

  it("移动端状态项只显示状态点（无 tokens/窗口列）", async () => {
    mockBaseApis();
    renderWithClient(<BottomPanel sessionId={session.id} agentState="streaming" mobile={true} />);
    const status = screen.getByLabelText("会话状态");
    expect(status).toHaveTextContent("正在输出");
    await waitFor(() => expect(api.context).toHaveBeenCalled());
    expect(status).not.toHaveTextContent("tok");
  });
});
