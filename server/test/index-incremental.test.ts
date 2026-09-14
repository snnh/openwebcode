import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreClientLike, IndexExtractSymbol } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 索引编排的假 core：文件表/符号表内存模拟，job 输出一次性回吐 JSONL。 */
class FakeCore {
  scanCalls = 0;
  extractCalls: string[][] = [];
  statCalls: string[][] = [];
  files = new Map<string, { size: number; modifiedMs: number }>();
  symbols = new Map<string, IndexExtractSymbol[]>();
  watchEvents: Array<{ path: string; kind: string }> = [];
  overflow = false;
  private readonly jobs = new Map<string, string>();

  async startIndexScan(request: { jobId: string }): Promise<void> {
    this.scanCalls += 1;
    const lines = [...this.files.entries()].map(([p, f]) => JSON.stringify({ path: p, size: f.size, modifiedMs: f.modifiedMs }));
    lines.push(JSON.stringify({ summary: { entries: this.files.size, truncated: false, reason: null } }));
    this.jobs.set(request.jobId, `${lines.join("\n")}\n`);
  }

  async startIndexExtract(request: { jobId: string; files: string[] }): Promise<void> {
    this.extractCalls.push(request.files);
    const lines = request.files.map((p) => JSON.stringify({ path: p, symbols: this.symbols.get(p) ?? [] }));
    lines.push(JSON.stringify({ summary: { files: request.files.length, symbols: 0, truncated: false, reason: null } }));
    this.jobs.set(request.jobId, `${lines.join("\n")}\n`);
  }

  async jobStatus(request: { jobId: string }): Promise<unknown> {
    return { jobId: request.jobId, state: "completed" };
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
    return { watchId: 1 };
  }

  async pollWatch(): Promise<unknown> {
    const events = this.watchEvents;
    this.watchEvents = [];
    // overflow 是一次性信号（core 上报后自清）：持续上报会让去抖永久滑动
    const overflow = this.overflow;
    this.overflow = false;
    return { events, overflow };
  }

  async statFiles(request: { paths: string[] }): Promise<unknown> {
    this.statCalls.push(request.paths);
    return {
      entries: request.paths
        .filter((p) => this.files.has(p))
        .map((p) => ({ path: p, type: "file", ...this.files.get(p)! })),
    };
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timeout");
}

describe("IndexManager watch 定向增量刷新（P7）", () => {
  it("watch 事件只定向刷新涉及路径，不再全盘重扫；删除同步移除", async () => {
    const root = await tempRoot("owc-index-inc-");
    const cwd = path.join(root, "ws");
    const core = new FakeCore();
    core.files.set("a.ts", { size: 10, modifiedMs: 1000 });
    core.files.set("b.ts", { size: 20, modifiedMs: 1000 });
    core.symbols.set("a.ts", [{ name: "alpha", kind: "function", startLine: 1, endLine: 1, signature: "function alpha()" }]);
    core.symbols.set("b.ts", [{ name: "beta", kind: "function", startLine: 1, endLine: 1, signature: "function beta()" }]);
    const manager = new IndexManager(core as unknown as CoreClientLike, path.join(root, "index"), new EventBus(), {
      pollMs: 1,
      watchPollMs: 10,
      refreshDebounceMs: 20,
    });
    try {
      await manager.rebuild("s1", cwd);
      await waitFor(() => core.scanCalls === 1);
      await waitFor(async () => (await manager.status("s1", cwd)).status === "fresh" ? true : false);
      // rebuild 后 watch 激活
      await waitFor(() => core.scanCalls === 1);

      // b.ts 修改：定向刷新（stat + extract 仅 b.ts），不触发第二次全量 scan
      core.files.set("b.ts", { size: 99, modifiedMs: 2000 });
      core.symbols.set("b.ts", [{ name: "betaV2", kind: "function", startLine: 1, endLine: 1, signature: "function betaV2()" }]);
      core.watchEvents.push({ path: "b.ts", kind: "changed" });
      await waitFor(() => core.statCalls.some((paths) => paths.includes("b.ts")));
      await waitFor(() => (core.extractCalls.at(-1) ?? []).join() === "b.ts");
      expect(core.scanCalls).toBe(1);

      const hits = await manager.searchSymbols(cwd, "betaV2");
      expect(hits.some((hit) => hit.path === "b.ts")).toBe(true);

      // a.ts 删除：从索引移除（以终态为准：fresh 且 files=1，refreshPaths 落盘有 await 窗口）
      core.files.delete("a.ts");
      core.watchEvents.push({ path: "a.ts", kind: "deleted" });
      await waitFor(async () => {
        const status = await manager.status("s1", cwd);
        return status.status === "fresh" && status.files === 1;
      });
      expect(core.scanCalls).toBe(1);
      expect((await manager.searchSymbols(cwd, "alpha")).length).toBe(0);
    } finally {
      manager.stop();
    }
  });

  it("watch 溢出降级为全量重建", async () => {
    const root = await tempRoot("owc-index-inc-");
    const cwd = path.join(root, "ws");
    const core = new FakeCore();
    core.files.set("a.ts", { size: 10, modifiedMs: 1000 });
    const manager = new IndexManager(core as unknown as CoreClientLike, path.join(root, "index"), new EventBus(), {
      pollMs: 1,
      watchPollMs: 10,
      refreshDebounceMs: 20,
    });
    try {
      await manager.rebuild("s1", cwd);
      await waitFor(() => core.scanCalls === 1);
      core.overflow = true;
      await waitFor(() => core.scanCalls === 2);
    } finally {
      manager.stop();
    }
  });
});
