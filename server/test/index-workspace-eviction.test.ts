import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { INDEX_WORKSPACE_IDLE_MS, INDEX_WORKSPACE_MAX, IndexManager } from "../src/index/index-manager.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 索引工作区常驻内存收敛：释放只丢内存索引表与文件监听，磁盘索引保留，下次访问按磁盘重建。 */
class FakeCore {
  scanCalls = 0;
  cancelled: number[] = [];
  files = new Map<string, { size: number; modifiedMs: number }>();
  private readonly jobs = new Map<string, string>();
  private nextWatchId = 1;
  async startIndexScan({ jobId }: { jobId: string }): Promise<void> {
    this.scanCalls += 1;
    const lines = [...this.files].map(([p, f]) => JSON.stringify({ path: p, size: f.size, modifiedMs: f.modifiedMs }));
    this.jobs.set(jobId, [...lines, JSON.stringify({ summary: { entries: this.files.size, truncated: false, reason: null } })].join("\n") + "\n");
  }

  async startIndexExtract({ jobId, files }: { jobId: string; files: string[] }): Promise<void> {
    const lines = files.map((p) => JSON.stringify({ path: p, symbols: [] }));
    this.jobs.set(jobId, [...lines, JSON.stringify({ summary: { files: files.length, symbols: 0, truncated: false, reason: null } })].join("\n") + "\n");
  }
  async jobStatus(): Promise<unknown> { return { state: "completed" }; }
  async cancelJob(): Promise<unknown> { return { cancelled: true }; }
  async watchFiles(): Promise<unknown> { return { watchId: this.nextWatchId++ }; }
  async cancelWatch({ watchId }: { watchId: number }): Promise<unknown> { this.cancelled.push(watchId); return { ok: true }; }
  async pollWatch(): Promise<unknown> { return { events: [], overflow: false }; }
  async jobOutput({ jobId, afterSeq }: { jobId: string; afterSeq: number }): Promise<unknown> {
    const data = this.jobs.get(jobId);
    if (!data || afterSeq > 0) return { chunks: [], nextSeq: afterSeq, truncated: false };
    return { chunks: [{ seq: 1, stream: "stdout", data: Buffer.from(data, "utf8").toString("base64") }], nextSeq: 2, truncated: false };
  }
}

/** 夹具：可控时钟 + 单文件工作区；touch 建好索引并等到就绪（watch 只在非 missing 时起）。 */
async function fixture() {
  const root = await tempRoot("owc-index-evict-");
  const core = new FakeCore();
  core.files.set("a.ts", { size: 10, modifiedMs: 1000 });
  let now = 1_000_000;
  const manager = new IndexManager(core as unknown as CoreClientLike, path.join(root, "index"), new EventBus(), { pollMs: 1, watchPollMs: 60_000, now: () => now });
  const touch = async (sessionId: string, cwd: string): Promise<void> => {
    await manager.rebuild(sessionId, cwd);
    await vi.waitFor(async () => expect(["fresh", "stale"]).toContain((await manager.status(sessionId, cwd)).status), { timeout: 3_000, interval: 5 });
  };
  return { core, manager, ws: (name: string) => path.join(root, name), touch, advance: (ms: number) => { now += ms; } };
}

describe("索引工作区空闲/容量淘汰", () => {
  it("空闲淘汰：超过空闲上限的工作区被释放（取消 core 监听），最近访问的不动", async () => {
    const { core, manager, ws, touch, advance } = await fixture();
    await touch("s1", ws("ws-a"));
    advance(INDEX_WORKSPACE_IDLE_MS - 1_000);
    await touch("s1", ws("ws-b"));
    // 再走 2 秒：ws-a 刚过上限、ws-b 仍新鲜 → 只释放 ws-a
    advance(2_000);
    expect(await manager.releaseIdle(INDEX_WORKSPACE_IDLE_MS)).toBe(1);
    expect(core.cancelled).toHaveLength(1);
    expect(await manager.releaseIdle(INDEX_WORKSPACE_IDLE_MS)).toBe(0);
  });

  it("容量淘汰：超出上限时按最近访问释放最旧的", async () => {
    const { manager, ws, touch, advance } = await fixture();
    for (let index = 0; index <= INDEX_WORKSPACE_MAX; index += 1) {
      await touch("s1", ws(`ws-${index}`));
      advance(1_000);
    }
    // 并发常驻 = MAX+1：只淘汰最旧的 ws-0
    expect(await manager.enforceLimit(INDEX_WORKSPACE_MAX)).toBe(1);
    expect(await manager.enforceLimit(INDEX_WORKSPACE_MAX)).toBe(0);
  });

  it("sweep 先空闲后容量（叠加时每个工作区只释放一次）；显式释放后再次访问按磁盘重建", async () => {
    const { core, manager, ws, touch, advance } = await fixture();
    const cwd = ws("ws-0");
    for (let index = 0; index <= INDEX_WORKSPACE_MAX; index += 1) {
      await touch("s1", ws(`ws-${index}`));
      advance(1_000);
    }
    advance(INDEX_WORKSPACE_IDLE_MS + 1);
    expect(await manager.sweep()).toBe(INDEX_WORKSPACE_MAX + 1);
    expect(await manager.sweep()).toBe(0);

    // 磁盘索引仍在：重新建工作区；未访问过的目录释放是空操作
    await touch("s1", cwd);
    const scansBefore = core.scanCalls;
    expect(await manager.release(cwd)).toBe(true);
    expect(await manager.release(ws("ws-unknown"))).toBe(false);
    await touch("s1", cwd);
    expect(core.scanCalls).toBeGreaterThan(scansBefore);
  });
});
