import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike, IndexExtractSymbol } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 索引编排的假 core：文件表/符号表内存模拟，job 输出一次性回吐 JSONL。 */
class FakeCore {
  scanCalls = 0;
  files = new Map<string, { size: number; modifiedMs: number }>();
  symbols = new Map<string, IndexExtractSymbol[]>();
  watchEvents: Array<{ path: string; kind: string }> = [];
  overflow = false;
  private readonly jobs = new Map<string, string>();
  async startIndexScan({ jobId }: { jobId: string }): Promise<void> {
    this.scanCalls += 1;
    const lines = [...this.files].map(([p, f]) => JSON.stringify({ path: p, size: f.size, modifiedMs: f.modifiedMs }));
    this.jobs.set(jobId, [...lines, JSON.stringify({ summary: { entries: this.files.size, truncated: false, reason: null } })].join("\n") + "\n");
  }

  async startIndexExtract({ jobId, files }: { jobId: string; files: string[] }): Promise<void> {
    const lines = files.map((p) => JSON.stringify({ path: p, symbols: this.symbols.get(p) ?? [] }));
    this.jobs.set(jobId, [...lines, JSON.stringify({ summary: { files: files.length, symbols: 0, truncated: false, reason: null } })].join("\n") + "\n");
  }

  async jobStatus(): Promise<unknown> { return { state: "completed" }; }
  async cancelJob(): Promise<unknown> { return { cancelled: true }; }
  async watchFiles(): Promise<unknown> { return { watchId: 1 }; }

  async jobOutput({ jobId, afterSeq }: { jobId: string; afterSeq: number }): Promise<unknown> {
    const data = this.jobs.get(jobId);
    if (!data || afterSeq > 0) return { chunks: [], nextSeq: afterSeq, truncated: false };
    return { chunks: [{ seq: 1, stream: "stdout", data: Buffer.from(data, "utf8").toString("base64") }], nextSeq: 2, truncated: false };
  }

  /** overflow 是一次性信号（core 上报后自清）：持续上报会让去抖永久滑动；events 取出即清空。 */
  async pollWatch(): Promise<unknown> {
    const overflow = this.overflow;
    this.overflow = false;
    const events = this.watchEvents;
    this.watchEvents = [];
    return { events, overflow };
  }

  async statFiles({ paths }: { paths: string[] }): Promise<unknown> {
    return { entries: paths.filter((p) => this.files.has(p)).map((p) => ({ path: p, type: "file", ...this.files.get(p)! })) };
  }
}

const symbol = (name: string): IndexExtractSymbol => ({ name, kind: "function", startLine: 1, endLine: 1, signature: `function ${name}()` });

/** 工作区夹具：seed 的每个文件都已落盘并带符号；watch 相关计时压到毫秒级。 */
async function fixture(seed: Array<[string, IndexExtractSymbol[]]>) {
  const root = await tempRoot("owc-index-inc-");
  const core = new FakeCore();
  for (const [file, symbols] of seed) { core.files.set(file, { size: 10, modifiedMs: 1000 }); core.symbols.set(file, symbols); }
  return { cwd: path.join(root, "ws"), core, manager: new IndexManager(core as unknown as CoreClientLike, path.join(root, "index"), new EventBus(), { pollMs: 1, watchPollMs: 10, refreshDebounceMs: 20 }) };
}

describe("IndexManager watch 定向增量刷新（P7）", () => {
  it("watch 事件只定向刷新涉及路径，不再全盘重扫；删除同步移除", async () => {
    const { cwd, core, manager } = await fixture([["a.ts", [symbol("alpha")]], ["b.ts", [symbol("beta")]]]);
    try {
      await manager.rebuild("s1", cwd);
      // rebuild 后 watch 激活：全量扫描只发生一次
      await vi.waitFor(async () => expect((await manager.status("s1", cwd)).status).toBe("fresh"), { timeout: 3_000 });
      expect(core.scanCalls).toBe(1);

      // b.ts 修改：定向刷新（只 stat/extract 该路径），不触发第二次全量 scan
      core.files.set("b.ts", { size: 99, modifiedMs: 2000 });
      core.symbols.set("b.ts", [symbol("betaV2")]);
      core.watchEvents.push({ path: "b.ts", kind: "changed" });
      await vi.waitFor(async () => expect((await manager.searchSymbols(cwd, "betaV2")).some((hit) => hit.path === "b.ts")).toBe(true), { timeout: 3_000 });
      expect(core.scanCalls).toBe(1);

      // a.ts 删除：索引同步移除（以终态为准：fresh 且 files=1，refreshPaths 落盘有 await 窗口）
      core.files.delete("a.ts");
      core.watchEvents.push({ path: "a.ts", kind: "deleted" });
      await vi.waitFor(async () => expect(await manager.status("s1", cwd)).toMatchObject({ status: "fresh", files: 1 }), { timeout: 3_000 });
      expect(core.scanCalls).toBe(1);
      expect(await manager.searchSymbols(cwd, "alpha")).toHaveLength(0);
    } finally { manager.stop(); }
  }, 20_000);

  it("watch 溢出降级为全量重建", async () => {
    const { cwd, core, manager } = await fixture([["a.ts", []]]);
    try {
      await manager.rebuild("s1", cwd);
      await vi.waitFor(() => expect(core.scanCalls).toBe(1), { timeout: 3_000 });
      core.overflow = true;
      await vi.waitFor(() => expect(core.scanCalls).toBe(2), { timeout: 3_000 });
    } finally { manager.stop(); }
  }, 20_000);
});
