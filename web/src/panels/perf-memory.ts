/**
 * 性能面板的内存拆分（纯函数，便于单测）：把 /api/metrics 的 memory 字段摊平成
 * 「总占用 / server 主线程 / C core / 扩展宿主」四行 + 主线程堆明细。
 *
 * 总占用 = 三者之和：这里是「本产品常驻进程」的口径——server 主线程（Node 堆 + 外部内存）、
 * C core（owc-exec，只报自身 RSS）、扩展宿主（独立 Node 子进程）。
 * core 与扩展宿主为 null（未握手 / 未启动 / 超时）时按 0 计入，并保留 null 让面板显示「—」，
 * 不把「测不到」伪装成「占 0」。
 */
import type { MemoryStats } from "../lib/contracts";

export interface MemoryBreakdown {
  /** 三者之和（缺测项按 0 计入） */
  total: number;
  serverRss: number;
  /** null = 该来源不可用（未握手/超时），面板显示「—」 */
  coreRss: number | null;
  extensionRss: number | null;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export function memoryBreakdown(memory: MemoryStats): MemoryBreakdown {
  const coreRss = memory.core?.rssBytes ?? null;
  const extensionRss = memory.extensionHost?.rss ?? null;
  return {
    total: memory.node.rss + (coreRss ?? 0) + (extensionRss ?? 0),
    serverRss: memory.node.rss,
    coreRss,
    extensionRss,
    heapUsed: memory.node.heapUsed,
    heapTotal: memory.node.heapTotal,
    external: memory.node.external,
  };
}
