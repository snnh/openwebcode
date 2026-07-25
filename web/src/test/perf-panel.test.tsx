import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PerfPanel } from "../components/panels/PerfPanel";

// mock perf-sampler 避免 jsdom 中 requestAnimationFrame 问题
vi.mock("../lib/perf-sampler", () => ({
  startFrameSampler: vi.fn(),
  stopFrameSampler: vi.fn(),
  getFpsStats: () => ({ fps50: 60, fps95: 55, droppedFrames: 2, sampleCount: 280 }),
  isSamplerActive: () => true,
}));

// mock api 避免真实网络请求
vi.mock("../lib/api", () => ({
  api: {
    sessionPerf: vi.fn().mockResolvedValue({
      records: [
        {
          runId: "run-1",
          sessionId: "s1",
          startedAt: "2026-07-25T00:00:00Z",
          finishedAt: "2026-07-25T00:00:05Z",
          turnCount: 3,
          stages: { contextBuildMs: 12.5, providerCallMs: 3200, toolExecMs: 850, totalMs: 4062.5 },
        },
      ],
    }),
    serverMetrics: vi.fn().mockResolvedValue({
      events: { published: 1234, retained: 100, retainedBytes: 524288, oversizedNotRetained: 0 },
      websocket: { clients: 2, slowClientDisconnects: 0, failedClientSends: 0 },
    }),
    providerStats: vi.fn().mockResolvedValue({
      files: { active: 0, queued: 0, maxConcurrent: 2 },
    }),
  },
}));

function renderPanel(sessionId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <PerfPanel sessionId={sessionId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("PerfPanel（0.5.0 Phase 2d）", () => {
  it("渲染帧率区域显示采样数据", () => {
    renderPanel("s1");
    expect(screen.getByText("FPS p50")).toBeDefined();
    expect(screen.getByText("60")).toBeDefined();
  });

  it("无会话时显示提示", () => {
    renderPanel(undefined);
    expect(screen.getByText(/选择会话以查看性能数据|Select a session/)).toBeDefined();
  });

  it("面板标题为性能", () => {
    renderPanel("s1");
    expect(screen.getByText("Performance")).toBeDefined();
  });
});
