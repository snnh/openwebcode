/**
 * 进程内单调递增的 ISO 时间戳：同毫秒连发 create 时按调用序 +1ms，
 * 保证 createdAt/updatedAt 字典序即创建顺序（列表 updatedAt desc 排序不再有平局，
 * 平局会退化为 readdir 顺序，CI 上表现为排序测试 flaky）。
 */
let lastIssuedMs = 0;

export function monotonicTimestamp(): string {
  const now = Date.now();
  lastIssuedMs = now > lastIssuedMs ? now : lastIssuedMs + 1;
  return new Date(lastIssuedMs).toISOString();
}
