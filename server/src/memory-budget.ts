/**
 * 进阶内存上限：服务端三进程 RSS（server + core + 扩展宿主）超过用户设置值时
 * 分级压缩可重建缓存。浏览器堆不纳入该阈值，由 Web 按运行模式单独控制。
 *
 * 分级：
 * 1. 清空闲缓存 + 节流 full GC；30 秒后复采样。
 * 2. 仍超限：执行并发降到 1、清全部可重建缓存 + full GC。
 * 低于上限 90% 时恢复所选模式的并发；活跃 run 的 pinned 数据始终不动。
 */
import type { RuntimeMode } from "./runtime-mode.js";

export interface MemoryBudgetConfig {
  enabled: boolean;
  budgetMB: number | null;
  runtimeMode: RuntimeMode;
}

export interface MemoryBudgetState {
  enabled: boolean;
  budgetMB: number | null;
  totalMB: number | null;
  level: 0 | 1 | 2;
  compressed: boolean;
  updatedAt: number | null;
}

export interface MemoryBudgetDeps {
  config(): MemoryBudgetConfig;
  /** server + core + 扩展宿主 RSS；任一来源不可用时按可得项返回，全部不可用返回 null。 */
  totalMB(): Promise<number | null>;
  sweep(): void;
  /** 二级压缩：释放全部可重建缓存（活跃 run 的 pinned 数据除外）。 */
  compress(): void;
  gc(): void;
  setExecConcurrency(value: number): void;
  /** 恢复模式/显式设置下的并发。 */
  restoreConcurrency(): number;
  onState(state: MemoryBudgetState): void;
  /** 可注入时钟（测试用）；缺省 Date.now。 */
  now?(): number;
}

export class MemoryBudget {
  private level: 0 | 1 | 2 = 0;
  private lastLevelAt = 0;
  private lastTotalMB: number | null = null;
  private evaluating = false;

  private readonly now: () => number;

  constructor(private readonly deps: MemoryBudgetDeps) {
    this.now = deps.now ?? Date.now;
  }

  state(): MemoryBudgetState {
    const config = this.deps.config();
    return {
      enabled: config.enabled && config.budgetMB !== null,
      budgetMB: config.budgetMB,
      totalMB: this.lastTotalMB,
      level: this.level,
      compressed: this.level > 0,
      updatedAt: this.lastLevelAt || null,
    };
  }

  async evaluate(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const config = this.deps.config();
      if (!config.enabled || config.budgetMB === null) {
        if (this.level !== 0) this.restore(config);
        this.lastTotalMB = null;
        // 关闭状态不广播：60s 定时器每轮 emit 会在无任何变化时持续占用 WS/事件循环。
        return;
      }
      const total = await this.deps.totalMB();
      this.lastTotalMB = total;
      if (total === null) {
        this.emit(config);
        return;
      }
      const budget = config.budgetMB;
      const now = this.now();
      if (total > budget) {
        if (this.level === 0) {
          this.level = 1;
          this.lastLevelAt = now;
          this.deps.sweep();
          this.deps.gc();
        } else if (this.level === 1 && now - this.lastLevelAt >= 30_000) {
          this.level = 2;
          this.lastLevelAt = now;
          this.deps.setExecConcurrency(1);
          this.deps.compress();
          this.deps.gc();
        }
      } else if (total < budget * 0.9 && this.level !== 0) {
        this.restore(config);
      }
      this.emit(config);
    } finally {
      this.evaluating = false;
    }
  }

  private restore(config: MemoryBudgetConfig): void {
    this.level = 0;
    this.lastLevelAt = this.now();
    this.deps.setExecConcurrency(this.deps.restoreConcurrency());
    this.emit(config);
  }

  private emit(config: MemoryBudgetConfig): void {
    this.deps.onState({
      enabled: config.enabled && config.budgetMB !== null,
      budgetMB: config.budgetMB,
      totalMB: this.lastTotalMB,
      level: this.level,
      compressed: this.level > 0,
      updatedAt: this.lastLevelAt || null,
    });
  }
}
