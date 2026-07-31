import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PerfPanel } from "../components/panels/PerfPanel";
import { startFrameSampler, stopFrameSampler } from "../lib/perf-sampler";
import { api } from "../lib/api";
import { renderWithClient } from "./helpers/with-client";

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
  return renderWithClient(
    <I18nProvider>
      <PerfPanel sessionId={sessionId} />
    </I18nProvider>,
  );
}

describe("PerfPanel（0.5.0 Phase 2d）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("渲染帧率区域显示采样数据", () => {
    renderPanel("s1");
    expect(screen.getByText("FPS p50")).toBeDefined();
    expect(screen.getByText("60")).toBeDefined();
  });

  it("无会话时显示提示", () => {
    renderPanel(undefined);
    expect(screen.getByText(/选择会话以查看性能数据|Select a session/)).toBeDefined();
  });

  it("可暂停并持久化实时性能监控", () => {
    renderPanel("s1");
    const toggle = screen.getByRole("switch", { name: /实时性能监控|Live performance monitoring/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(startFrameSampler).toHaveBeenCalled();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(stopFrameSampler).toHaveBeenCalled();
    expect(window.localStorage.getItem("owc-perf-monitoring")).toBe("false");
    expect(screen.getByText(/实时采样与数据刷新已暂停|Live sampling and data refresh are paused/)).toBeDefined();
  });

  it("刷新后保持暂停且不启动采样或轮询", () => {
    window.localStorage.setItem("owc-perf-monitoring", "false");
    renderPanel("s1");

    expect(screen.getByRole("switch", { name: /实时性能监控|Live performance monitoring/ })).toHaveAttribute("aria-checked", "false");
    expect(startFrameSampler).not.toHaveBeenCalled();
    expect(api.sessionPerf).not.toHaveBeenCalled();
    expect(api.serverMetrics).not.toHaveBeenCalled();
    expect(api.providerStats).not.toHaveBeenCalled();
  });
});
