/**
 * 运行模式：性能优先 / 平衡 / 内存优先。
 *
 * 模式只决定可重建缓存的容量倍率、执行并发、空闲逐出与 Web 窗口；
 * 它不改变安全网（pinned 上限、路径策略、权限）也不自动重启子进程。
 */
export type RuntimeMode = "performance" | "balanced" | "memory";

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "balanced";

export const RUNTIME_MODES: RuntimeMode[] = ["performance", "balanced", "memory"];

export interface RuntimeProfile {
  execConcurrency: number;
  cacheScale: number;
  gcIntervalMs: number;
  webPageMessages: number;
  webPageSessions: number;
}

const RUNTIME_PROFILES: Record<RuntimeMode, RuntimeProfile> = {
  performance: {
    execConcurrency: 4,
    cacheScale: 1.7,
    gcIntervalMs: 5 * 60_000,
    webPageMessages: 4000,
    webPageSessions: 20,
  },
  balanced: {
    execConcurrency: 2,
    cacheScale: 1,
    gcIntervalMs: 3 * 60_000,
    webPageMessages: 2000,
    webPageSessions: 10,
  },
  memory: {
    execConcurrency: 1,
    cacheScale: 0.6,
    gcIntervalMs: 60_000,
    webPageMessages: 1000,
    webPageSessions: 5,
  },
};

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "performance" || value === "balanced" || value === "memory";
}

export function runtimeProfile(mode: RuntimeMode): RuntimeProfile {
  return RUNTIME_PROFILES[mode];
}

/**
 * 生效的空闲逐出分钟数：模式决定上限，用户在“缓存空闲释放”里显式设置的值
 * 只能让释放更早，不能把性能模式重新变成按时间逐出。
 * - performance: 0（不逐出）
 * - balanced: 用户值（默认 10）
 * - memory: min(用户值或 3, 3)
 */
export function effectiveIdleMinutes(mode: RuntimeMode, configuredMinutes: number): number {
  if (mode === "performance") return 0;
  if (mode === "memory") return Math.min(configuredMinutes > 0 ? configuredMinutes : 3, 3);
  return configuredMinutes;
}
