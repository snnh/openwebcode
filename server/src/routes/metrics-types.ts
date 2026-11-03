/** 内存占用统计（/api/metrics 的 memory 字段）：独立类型文件，供 system.ts 与
 * scripts/contracts-check 引用——该文件不得 import 任何运行时模块，
 * 否则契约检查会把整个 server 依赖图拖进 ES2022-only 环境。 */
export interface MemoryStats {
  node: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
  core: { rssBytes: number } | null;
  extensionHost: { rss: number } | null;
}

/** 执行队列快照（/api/metrics exec 字段）。 */
export interface ExecStatsView {
  running: number;
  queued: number;
  maxConcurrent: number;
  oldestWaitMs: number;
  items: Array<{ sessionId: string; execId: string; state: "running" | "queued"; waitMs: number }>;
}

/** 进阶内存上限状态（/api/metrics memoryBudget 字段）。 */
export interface MemoryBudgetView {
  enabled: boolean;
  budgetMB: number | null;
  totalMB: number | null;
  level: 0 | 1 | 2;
  compressed: boolean;
  updatedAt: number | null;
}
