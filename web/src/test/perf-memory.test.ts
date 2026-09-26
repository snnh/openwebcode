import { describe, expect, it } from "vitest";
import { memoryBreakdown } from "../panels/perf-memory";

describe("性能面板内存拆分", () => {
  it("总占用 = server 主线程 + C core + 扩展宿主", () => {
    const memory = memoryBreakdown({
      node: { rss: 900, heapUsed: 400, heapTotal: 500, external: 5 },
      core: { rssBytes: 3 },
      extensionHost: { rss: 165 },
    });
    expect(memory.total).toBe(1068);
    expect(memory.serverRss).toBe(900);
    expect(memory.coreRss).toBe(3);
    expect(memory.extensionRss).toBe(165);
    expect([memory.heapUsed, memory.heapTotal, memory.external]).toEqual([400, 500, 5]);
  });
  it("来源不可用（null）按 0 计入总数，但保留 null 让面板显示「—」", () => {
    const onlyNode = memoryBreakdown({ node: { rss: 900, heapUsed: 400, heapTotal: 500, external: 0 }, core: null, extensionHost: null });
    expect(onlyNode.total).toBe(900);
    expect(onlyNode.coreRss).toBeNull();
    expect(onlyNode.extensionRss).toBeNull();
    // core 可用、扩展宿主不可用（扩展未启动）
    const withCore = memoryBreakdown({ node: { rss: 100, heapUsed: 1, heapTotal: 2, external: 0 }, core: { rssBytes: 7 }, extensionHost: null });
    expect(withCore.total).toBe(107);
    expect(withCore.extensionRss).toBeNull();
  });
});
