import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobHeader } from "../components/JobHeader";
import { api } from "../lib/api";
import type { ContextWindowInfo } from "../lib/context-window";
import type { SessionDetail, ContextUsage } from "../lib/contracts";

const session: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "模式切换测试",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [],
};

afterEach(() => vi.restoreAllMocks());

describe("JobHeader mode switches", () => {
  it("updates sandbox, shell, and snapshot modes while idle", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onConfig = vi.fn(async () => undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="idle" onAbort={() => undefined} onConfig={onConfig} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(api.sandboxCapabilities).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("沙盒模式"), { target: { value: "off" } });
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ sandboxMode: "off" }));
    fireEvent.change(screen.getByLabelText("Shell 后端"), { target: { value: "pwsh" } });
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ shellBackend: "pwsh" }));
    fireEvent.change(screen.getByLabelText("快照模式"), { target: { value: "manual" } });
    await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ snapshotMode: "manual" }));
    expect(screen.getByRole("option", { name: "Windows Sandbox" })).toBeDisabled();
  });

  it("disables both switches while the agent is running", () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="thinking" onAbort={() => undefined} onConfig={async () => undefined} />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("沙盒模式")).toBeDisabled();
    expect(screen.getByLabelText("快照模式")).toBeDisabled();
    expect(screen.getByLabelText("Shell 后端")).toBeDisabled();
  });

  it("offers an explicit manual snapshot action for an idle managed disk workspace", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const onCreateCheckpoint = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const managedSession: SessionDetail = {
      ...session,
      workspace: {
        mode: "managed",
        backend: "vhdx",
        originCwd: "C:\\source-workspace",
        image: "C:\\data\\workspaces\\session-1\\base.vhdx",
        mountPoint: "C:\\data\\mnt\\session-1",
      },
    };

    render(
      <QueryClientProvider client={client}>
        <JobHeader
          session={managedSession}
          agentState="idle"
          onAbort={() => undefined}
          onConfig={async () => undefined}
          onCreateCheckpoint={onCreateCheckpoint}
        />
      </QueryClientProvider>,
    );

    const button = screen.getByRole("button", { name: "创建虚拟磁盘快照" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onCreateCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("keeps the managed-disk snapshot action disabled while the session is running", () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: true } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const managedSession: SessionDetail = {
      ...session,
      workspace: {
        mode: "managed",
        backend: "qcow2",
        originCwd: "/source-workspace",
        image: "/data/workspaces/session-1/base.qcow2",
        mountPoint: "/data/mnt/session-1",
      },
    };

    render(
      <QueryClientProvider client={client}>
        <JobHeader
          session={managedSession}
          agentState="idle"
          running
          onAbort={() => undefined}
          onConfig={async () => undefined}
          onCreateCheckpoint={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "创建虚拟磁盘快照" })).toBeDisabled();
  });
});

describe("JobHeader 上下文窗口 meter", () => {
  function renderHeader(windowUsage: ContextWindowInfo): void {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试" } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="idle" windowUsage={windowUsage} onAbort={() => undefined} onConfig={async () => undefined} />
      </QueryClientProvider>,
    );
  }

  const base: ContextWindowInfo = {
    estimatedTokens: 45_000,
    contextWindow: 128_000,
    workingBudget: 120_000,
    utilization: 0.375,
    segments: { system: 0, compactionSummary: 0, toolResults: 0, messages: 45_000, repoMap: 0, other: 0 },
    pinnedTokens: 0,
  };

  it("显示 45k/128k · 38% 与 normal 水位", () => {
    renderHeader(base);
    const meter = screen.getByTestId("window-usage");
    expect(meter.textContent).toContain("45k/128k · 38%");
    expect(meter.dataset.level).toBe("normal");
  });

  it("≥70% 标记 warn，≥85% 标记 danger", () => {
    renderHeader({ ...base, utilization: 0.72 });
    renderHeader({ ...base, utilization: 0.9 });
    const meters = screen.getAllByTestId("window-usage");
    expect(meters[0]!.dataset.level).toBe("warn");
    expect(meters[1]!.dataset.level).toBe("danger");
    expect(meters[1]!.querySelector(".budget-bar")!.className).toContain("level-danger");
  });

  it("窗口未知时仅显示估算 tokens，不显示百分比", () => {
    renderHeader({ estimatedTokens: 45_000, segments: base.segments, pinnedTokens: 0 });
    const meter = screen.getByTestId("window-usage");
    expect(meter.textContent).toContain("45k");
    expect(meter.textContent).not.toContain("%");
    expect(meter.querySelector(".budget-bar")).toBeNull();
  });
});

describe("JobHeader 缓存命中 badge", () => {
  function renderHeader(latestUsage?: ContextUsage): void {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试" } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="idle" {...(latestUsage ? { latestUsage } : {})} onAbort={() => undefined} onConfig={async () => undefined} />
      </QueryClientProvider>,
    );
  }

  const usage: ContextUsage = { inputTokens: 21_000, outputTokens: 500, cacheRead: 98_000, cacheWrite: 12_000 };

  it("显示最近一轮命中率与 tooltip 明细", () => {
    renderHeader(usage);
    const badge = screen.getByTestId("cache-usage");
    // 98k / (21k + 98k) ≈ 82%
    expect(badge.textContent).toBe("缓存 82%");
    expect(badge.title).toContain("缓存读取 98k");
    expect(badge.title).toContain("写入 12k");
    expect(badge.title).toContain("未缓存输入 21k");
  });

  it("无用量数据时隐藏 badge", () => {
    renderHeader();
    expect(screen.queryByTestId("cache-usage")).toBeNull();
  });

  it("总输入为 0（rate null）时隐藏 badge", () => {
    renderHeader({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    expect(screen.queryByTestId("cache-usage")).toBeNull();
  });
});

describe("JobHeader 导出", () => {
  it("包含指向 /api/sessions/<id>/export.md 的「导出 Markdown」链接", () => {
    vi.spyOn(api, "tasks").mockResolvedValue([]);
    vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试" } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <JobHeader session={session} agentState="idle" onAbort={() => undefined} onConfig={async () => undefined} />
      </QueryClientProvider>,
    );

    const link = screen.getByRole("link", { name: "导出 Markdown" });
    expect(link).toHaveAttribute("href", "/api/sessions/session-1/export.md");
    expect(link).toHaveAttribute("download");
  });
});
