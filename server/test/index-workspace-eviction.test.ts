import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreClientLike, IndexExtractSymbol } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { INDEX_WORKSPACE_IDLE_MS, INDEX_WORKSPACE_MAX, IndexManager } from "../src/index/index-manager.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * 索引工作区的常驻内存收敛：空闲淘汰、容量淘汰、显式释放（归档）。
 * 释放只丢内存里的索引表与文件监听，磁盘索引保留，下次访问按磁盘重建。
 */
class FakeCore {
  scanCalls = 0;
  cancelled: number[] = [];
  files = new Map<string, { size: number; modifiedMs: number }>();
  symbols = new Map<string, IndexExtractSymbol[]>();
  private readonly jobs = new Map<string, string>();
  private nextWatchId = 1;

  async startIndexScan(request: { jobId: string }): Promise<void> {
    this.scanCalls += 1;
    const lines = [...this.files.entries()].map(([p, f]) => JSON.stringify({ path: p, size: f.size, modifiedMs: f.modifiedMs }));
    lines.push(JSON.stringify({ summary: { entries: this.files.size, truncated: false, reason: null } }));
    this.jobs.set(request.jobId, `${lines.join("\n")}\n`);
  }

  async startIndexExtract(request: { jobId: string; files: string[] }): Promise<void> {
    const lines = request.files.map((p) => JSON.stringify({ path: p, symbols: this.symbols.get(p) ?? [] }));
    lines.push(JSON.stringify({ summary: { files: request.files.length, symbols: 0, truncated: false, reason: null } }));
    this.jobs.set(request.jobId, `${lines.join("\n")}\n`);
  }

  async jobStatus(): Promise<unknown> {
    return { state: "completed" };
  }

  async jobOutput(request: { jobId: string; afterSeq: number }): Promise<unknown> {
    const data = this.jobs.get(request.jobId);
    if (!data || request.afterSeq > 0) return { chunks: [], nextSeq: request.afterSeq, truncated: false };
    return { chunks: [{ seq: 1, stream: "stdout", data: Buffer.from(data, "utf8").toString("base64") }], nextSeq: 2, truncated: false };
  }

  async cancelJob(): Promise<unknown> {
    return { cancelled: true };
  }

  async watchFiles(): Promise<unknown> {
    return { watchId: this.nextWatchId++ };
  }

  async cancelWatch(request: { watchId: number }): Promise<unknown> {
    this.cancelled.push(request.watchId);
    return { ok: true };
  }

  async pollWatch(): Promise<unknown> {
    return { events: [], overflow: false };
  }
}

async function fixture() {
  const root = await tempRoot("owc-index-evict-");
  const core = new FakeCore();
  core.files.set("a.ts", { size: 10, modifiedMs: 1000 });
  let now = 1_000_000;
  const manager = new IndexManager(core as unknown as CoreClientLike, path.join(root, "index"), new EventBus(), {
    pollMs: 1,
    watchPollMs: 60_000,
    now: () => now,
  });
  const ws = (name: string): string => path.join(root, name);
  /** 触碰一个工作区：建好索引（status 非 missing 时才会起 watch）并等到就绪 */
  const touch = async (sessionId: string, cwd: string): Promise<void> => {
    await manager.rebuild(sessionId, cwd);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const info = await manager.status(sessionId, cwd);
      if (info.status === "fresh" || info.status === "stale") return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`index not ready for ${cwd}`);
  };
  return { root, core, manager, ws, touch, advance: (ms: number) => { now += ms; } };
}

describe("索引工作区空闲/容量淘汰", () => {
  it("空闲淘汰：超过空闲上限的工作区被释放（取消 core 监听），最近访问的不动", async () => {
    const { core, manager, ws, touch, advance } = await fixture();
    await touch("s1", ws("ws-a"));
    advance(INDEX_WORKSPACE_IDLE_MS - 1_000);
    await touch("s1", ws("ws-b"));

    // 再走 2 秒：ws-a 超时（刚过上限），ws-b 仍新鲜 → 只释放 ws-a
    advance(2_000);
    expect(await manager.releaseIdle(INDEX_WORKSPACE_IDLE_MS)).toBe(1);
    expect(core.cancelled.length).toBe(1);
    // 再次空闲淘汰无对象
    expect(await manager.releaseIdle(INDEX_WORKSPACE_IDLE_MS)).toBe(0);
  });

  it("容量淘汰：超出上限时按最近访问释放最旧的", async () => {
    const { manager, ws, touch, advance } = await fixture();
    for (let index = 0; index <= INDEX_WORKSPACE_MAX; index += 1) {
      await touch("s1", ws(`ws-${index}`));
      advance(1_000);
    }
    // 并发常驻 = MAX+1：淘汰 1 个（最旧的 ws-0）
    expect(await manager.enforceLimit(INDEX_WORKSPACE_MAX)).toBe(1);
    expect(await manager.enforceLimit(INDEX_WORKSPACE_MAX)).toBe(0);
  });

  it("显式释放（归档/删除用）后再次访问：按磁盘重建（索引文件仍在）", async () => {
    const { core, manager, ws, touch } = await fixture();
    const cwd = ws("ws-rebuild");
    await touch("s1", cwd);
    const scansBefore = core.scanCalls;
    expect(await manager.release(cwd)).toBe(true);
    // 未访问过的目录释放是空操作
    expect(await manager.release(ws("ws-unknown"))).toBe(false);
    expect(core.cancelled.length).toBe(1);

    await touch("s1", cwd);
    // 重新建立工作区并扫描（磁盘索引复用，索引内容不丢）
    expect(core.scanCalls).toBeGreaterThan(scansBefore);
  });

  it("sweep：先空闲淘汰再容量淘汰，返回释放总数", async () => {
    const { manager, ws, touch, advance } = await fixture();
    for (let index = 0; index <= INDEX_WORKSPACE_MAX; index += 1) {
      await touch("s1", ws(`ws-${index}`));
      advance(1_000);
    }
    // 全部空闲超时 + 容量超限：两者叠加，但每个工作区只释放一次
    advance(INDEX_WORKSPACE_IDLE_MS + 1);
    expect(await manager.sweep()).toBe(INDEX_WORKSPACE_MAX + 1);
    expect(await manager.sweep()).toBe(0);
  });
});
