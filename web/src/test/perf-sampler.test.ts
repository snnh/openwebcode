import { afterEach, describe, expect, it, vi } from "vitest";
import { getFpsStats, isSamplerActive, startFrameSampler, stopFrameSampler } from "../lib/perf-sampler";

describe("perf-sampler（0.5.0 Phase 2d）", () => {
  afterEach(() => {
    stopFrameSampler();
    vi.restoreAllMocks();
  });

  it("初始状态未激活，getFpsStats 返回零值", () => {
    expect(isSamplerActive()).toBe(false);
    const stats = getFpsStats();
    expect(stats.fps50).toBe(0);
    expect(stats.fps95).toBe(0);
    expect(stats.droppedFrames).toBe(0);
    expect(stats.sampleCount).toBe(0);
  });

  it("startFrameSampler 激活采样器", () => {
    let rafCallback: ((ts: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    startFrameSampler();
    expect(isSamplerActive()).toBe(true);

    // 模拟几帧
    expect(rafCallback).not.toBeNull();
    rafCallback!(0);
    rafCallback!(16.67);
    rafCallback!(33.34);

    const stats = getFpsStats();
    expect(stats.sampleCount).toBe(2); // 两帧间隔
    expect(stats.fps50).toBeGreaterThan(0);

    stopFrameSampler();
    expect(isSamplerActive()).toBe(false);
  });

  it("重复调用 startFrameSampler 不会创建多个实例", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    startFrameSampler();
    startFrameSampler();
    expect(isSamplerActive()).toBe(true);
    stopFrameSampler();
    expect(isSamplerActive()).toBe(false);
  });

  it("掉帧检测：帧间隔 > 33ms 计为掉帧", () => {
    let rafCallback: ((ts: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    startFrameSampler();
    // 模拟正常帧 + 掉帧
    rafCallback!(0);
    rafCallback!(16); // 正常
    rafCallback!(50); // 34ms 间隔 > 33ms → 掉帧
    rafCallback!(66); // 正常

    const stats = getFpsStats();
    expect(stats.droppedFrames).toBe(1);
    expect(stats.sampleCount).toBe(3);
    stopFrameSampler();
  });
});
