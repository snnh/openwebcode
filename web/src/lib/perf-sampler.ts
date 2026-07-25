/**
 * 0.5.0 Phase 2d：渲染帧率采样器。
 * 用 requestAnimationFrame 循环计算帧间隔，维护滑动窗口（最近 300 帧），
 * 只在诊断页/性能面板打开时激活（按需采样，不常驻）。
 */

export interface FpsStats {
  /** 帧率中位数 */
  fps50: number;
  /** 帧率 p95（即 95% 的帧不低于此值） */
  fps95: number;
  /** 掉帧数（帧间隔 > 33ms，即低于 30fps 的帧） */
  droppedFrames: number;
  /** 采样帧数 */
  sampleCount: number;
}

const WINDOW_SIZE = 300;
const DROP_THRESHOLD_MS = 33; // 低于 30fps 视为掉帧

interface SamplerState {
  rafId: number;
  lastTimestamp: number;
  intervals: number[];
  droppedFrames: number;
}

let active: SamplerState | null = null;

function loop(timestamp: number): void {
  if (!active) return;
  if (active.lastTimestamp >= 0) {
    const interval = timestamp - active.lastTimestamp;
    active.intervals.push(interval);
    if (active.intervals.length > WINDOW_SIZE) active.intervals.shift();
    if (interval > DROP_THRESHOLD_MS) active.droppedFrames++;
  }
  active.lastTimestamp = timestamp;
  active.rafId = requestAnimationFrame(loop);
}

/** 启动帧率采样（若已启动则忽略）。 */
export function startFrameSampler(): void {
  if (active) return;
  active = { rafId: 0, lastTimestamp: -1, intervals: [], droppedFrames: 0 };
  active.rafId = requestAnimationFrame(loop);
}

/** 停止帧率采样并清理。 */
export function stopFrameSampler(): void {
  if (!active) return;
  cancelAnimationFrame(active.rafId);
  active = null;
}

/** 获取当前帧率统计（采样中或停止后均可调用；无数据时返回零值）。 */
export function getFpsStats(): FpsStats {
  if (!active || active.intervals.length === 0) {
    return { fps50: 0, fps95: 0, droppedFrames: 0, sampleCount: 0 };
  }
  const sorted = [...active.intervals].sort((a, b) => a - b);
  const p50Interval = sorted[Math.floor(sorted.length * 0.5)] ?? 16.67;
  const p95Interval = sorted[Math.floor(sorted.length * 0.95)] ?? 16.67;
  return {
    fps50: Math.round(1000 / Math.max(1, p50Interval)),
    fps95: Math.round(1000 / Math.max(1, p95Interval)),
    droppedFrames: active.droppedFrames,
    sampleCount: active.intervals.length,
  };
}

/** 采样器是否正在运行。 */
export function isSamplerActive(): boolean {
  return active !== null;
}
