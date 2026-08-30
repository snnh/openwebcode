/** 内存占用统计（/api/metrics 的 memory 字段）：独立类型文件，供 system.ts 与
 * scripts/contracts-check 引用——该文件不得 import 任何运行时模块，
 * 否则契约检查会把整个 server 依赖图拖进 ES2022-only 环境。 */
export interface MemoryStats {
  node: { rss: number; heapUsed: number; heapTotal: number; external: number };
  core: { rssBytes: number } | null;
  extensionHost: { rss: number } | null;
}
