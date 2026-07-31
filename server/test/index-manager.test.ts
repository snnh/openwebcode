import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike, IndexScanEntry } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { IndexManager, IndexUnavailableError } from "../src/index/index-manager.js";
import { languageForPath, workspaceHash, type SymbolRecord } from "../src/index/index-store.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const managers: IndexManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop();
});

const CWD = "/repo";
const UTIL_TS = `export function getTopSymbols(list: string[]): string {\n  return list[0] ?? "";\n}\n\nexport class Helper {\n  private static createDefault() {\n    return new Helper();\n  }\n}\n`;
const MAIN_PY = `def top_level(a, b):\n    return a\n`;

function manifestJsonl(entries: IndexScanEntry[]): string {
  return [
    ...entries.map((entry) => JSON.stringify(entry)),
    JSON.stringify({ summary: { entries: entries.length, truncated: false, reason: null, hashTruncated: false } }),
  ].join("\n") + "\n";
}

function extractJsonl(files: string[], symbols: Record<string, SymbolRecord[]>, summary?: { truncated: boolean; reason: "bytes" | "time" | null }): string {
  return [
    ...files.map((filePath) => JSON.stringify({ path: filePath, symbols: symbols[filePath] ?? [] })),
    JSON.stringify({
      summary: summary
        ? { files: files.length, symbols: files.reduce((sum, filePath) => sum + (symbols[filePath]?.length ?? 0), 0), ...summary }
        : { files: files.length, symbols: files.reduce((sum, filePath) => sum + (symbols[filePath]?.length ?? 0), 0), truncated: false, reason: null },
    }),
  ].join("\n") + "\n";
}

interface FakeScanCoreOptions {
  manifest: IndexScanEntry[];
  /** index.extract 回放的符号表（替代真实提取，提取逻辑已下沉 core）。 */
  symbols: Record<string, SymbolRecord[]>;
  stats?: Map<string, { size: number; modifiedMs: number }>;
  watchMode: "fail" | "active";
  /** true 时 jobStatus 永远 running（取消路径测试用）。 */
  neverFinish?: boolean;
}

/** fake core：index.scan / index.extract job 分别回放预置 manifest 与符号 JSONL；statFiles 由内存表供数。 */
function createFakeScanCore(options: FakeScanCoreOptions) {
  const state = {
    extractedFiles: [] as string[],
    cancelCalls: [] as string[],
    scanRequests: [] as unknown[],
    extractRequests: [] as unknown[],
    extractFilesByJob: new Map<string, string[]>(),
    pollEvents: [] as Array<{ path: string; kind: "created" | "changed" | "deleted" | "renamed" }>,
    servedJobs: new Set<string>(),
    /** 这些文件不出现在 extract 输出（模拟 core 截断未处理）。 */
    skipExtractFiles: [] as string[],
    /** extract summary 的 truncated/reason 覆盖。 */
    extractSummary: undefined as { truncated: boolean; reason: "bytes" | "time" | null } | undefined,
    /** true 时 jobOutput 报 truncated（core 输出 ring 溢出）。 */
    outputTruncated: false,
  };
  const core = {
    on() { return core; },
    setRequestTimeoutMs() {},
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async cleanupSession() { return { ok: true }; },
    async startIndexScan(request: { jobId: string }) {
      state.scanRequests.push(request);
      state.servedJobs.delete(request.jobId);
      return { jobId: request.jobId, state: "running" as const };
    },
    async startIndexExtract(request: { jobId: string; files?: string[] }) {
      state.extractRequests.push(request);
      const files = request.files ?? [];
      state.extractFilesByJob.set(request.jobId, files);
      state.extractedFiles.push(...files);
      state.servedJobs.delete(request.jobId);
      return { jobId: request.jobId, state: "running" as const };
    },
    async jobStatus(request: { jobId: string }) {
      if (options.neverFinish) {
        return state.cancelCalls.length > 0
          ? { jobId: request.jobId, state: "cancelled" as const }
          : { jobId: request.jobId, state: "running" as const };
      }
      return { jobId: request.jobId, state: "completed" as const };
    },
    async jobOutput(request: { jobId: string; afterSeq: number }) {
      if (options.neverFinish) return { chunks: [], nextSeq: request.afterSeq, truncated: false };
      if (state.outputTruncated) return { chunks: [], nextSeq: request.afterSeq, truncated: true };
      if (request.afterSeq !== 0 || state.servedJobs.has(request.jobId)) {
        return { chunks: [], nextSeq: request.afterSeq, truncated: false };
      }
      state.servedJobs.add(request.jobId);
      const data = request.jobId.endsWith("-x")
        ? extractJsonl((state.extractFilesByJob.get(request.jobId) ?? []).filter((file) => !state.skipExtractFiles.includes(file)), options.symbols, state.extractSummary)
        : manifestJsonl(options.manifest);
      return { chunks: [{ seq: 1, stream: "stdout" as const, data }], nextSeq: 2, truncated: false };
    },
    async cancelJob(request: { jobId: string }) {
      state.cancelCalls.push(request.jobId);
      return { jobId: request.jobId, accepted: true as const };
    },
    async statFiles(request: { paths: string[] }) {
      const entries = request.paths.map((p) => {
        const stat = options.stats?.get(p);
        if (!stat) throw new Error(`stat failed: ${p}`);
        return { path: p, type: "file" as const, ...stat };
      });
      return { entries };
    },
    async statFile() { return { type: "directory" as const, size: 0, modifiedMs: 1 }; },
    async scanFiles() { return { entries: [], truncated: false }; },
    async watchFiles() {
      if (options.watchMode === "fail") throw new Error("fs.watch unavailable");
      return { watchId: 7 };
    },
    async pollWatch() {
      const events = state.pollEvents.splice(0);
      return { events, overflow: false };
    },
    async cancelWatch() { return { ok: true as const }; },
  } as unknown as CoreClientLike;
  return { core: core as CoreClientLike, state };
}

function createManager(core: CoreClientLike, indexRoot: string, events: EventBus, options: { autoRefresh?: boolean; watchPollMs?: number } = {}): IndexManager {
  const manager = new IndexManager(core, indexRoot, events, { pollMs: 1, watchPollMs: options.watchPollMs ?? 5, refreshDebounceMs: 5, autoRefresh: options.autoRefresh ?? false });
  managers.push(manager);
  return manager;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const BASE_MANIFEST: IndexScanEntry[] = [
  { path: "src/util.ts", size: UTIL_TS.length, modifiedMs: 100, sha256: "u1" },
  { path: "src/main.py", size: MAIN_PY.length, modifiedMs: 100, sha256: "m1" },
  { path: "README.md", size: 20, modifiedMs: 100, sha256: "r1" },
];
const BASE_SYMBOLS: Record<string, SymbolRecord[]> = {
  "src/util.ts": [
    { name: "getTopSymbols", kind: "function", startLine: 1, endLine: 3, signature: "export function getTopSymbols(list: string[]): string {" },
    { name: "Helper", kind: "class", startLine: 5, endLine: 9, signature: "export class Helper {" },
    { name: "createDefault", kind: "method", startLine: 6, endLine: 8, signature: "private static createDefault() {" },
  ],
  "src/main.py": [
    { name: "top_level", kind: "function", startLine: 1, endLine: 1, signature: "def top_level(a, b):" },
  ],
};

describe("IndexManager", () => {
  it("rebuild 建立索引：manifest 入库、符号可搜、状态 fresh、事件齐全", async () => {
    const root = await tempRoot("owc-index-");
    const events = new EventBus();
    const seen: AppEvent[] = [];
    events.on("event", (event: AppEvent) => { if (event.type === "index.status") seen.push(event); });
    const { core } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail" });
    const manager = createManager(core, path.join(root, "index"), events);

    const { jobId } = await manager.rebuild("s1", CWD);
    expect(jobId).toMatch(/^index-/);
    await waitFor(async () => (await manager.status("s1", CWD)).status !== "building");

    const status = await manager.status("s1", CWD);
    expect(status).toMatchObject({ status: "fresh", files: 3, watch: "fallback" });
    expect(status.symbols).toBeGreaterThanOrEqual(3); // getTopSymbols + Helper + createDefault + top_level

    const hits = await manager.searchSymbols(CWD, "getTop");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: "getTopSymbols", kind: "function", path: "src/util.ts", startLine: 1 });
    // kind 过滤 + limit
    expect((await manager.searchSymbols(CWD, "e", { kind: "class" })).map((hit) => hit.name)).toEqual(["Helper"]);
    expect(await manager.searchSymbols(CWD, "e", { limit: 1 })).toHaveLength(1);
    expect(await manager.searchSymbols(CWD, "zzzz-not-exist")).toEqual([]);

    // 存储文件落盘（§7.1 布局）
    const dir = path.join(root, "index", workspaceHash(CWD));
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8")) as { version: number; files: number };
    expect(meta).toMatchObject({ version: 1, files: 3 });
    expect((await readFile(path.join(dir, "files.jsonl"), "utf-8")).trim().split("\n").length).toBeGreaterThan(1);

    // 事件：building → fresh（watch 降级 fallback 也会发一条）
    expect(seen.some((event) => (event.payload as { status: string }).status === "building")).toBe(true);
    expect(seen.some((event) => (event.payload as { status: string }).status === "fresh")).toBe(true);
  });

  it("增量重建只对变化文件重提符号，删除文件的符号被清除", async () => {
    const root = await tempRoot("owc-index-");
    const { core, state } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail" });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");
    expect(state.extractedFiles.sort()).toEqual(["src/main.py", "src/util.ts"]);

    // 第二次扫描：util.ts hash 变化、main.py 删除、新增 added.py；README.md 不变
    const addedPy = "def added_fn():\n    pass\n";
    state.extractedFiles.length = 0;
    BASE_SYMBOLS["src/added.py"] = [
      { name: "added_fn", kind: "function", startLine: 1, endLine: 2, signature: "def added_fn():" },
    ];
    delete BASE_SYMBOLS["src/main.py"];
    // fake 的 manifest 是引用捕获，直接改数组
    BASE_MANIFEST.splice(0, BASE_MANIFEST.length,
      { path: "src/util.ts", size: UTIL_TS.length, modifiedMs: 200, sha256: "u2" },
      { path: "src/added.py", size: addedPy.length, modifiedMs: 200, sha256: "a1" },
      { path: "README.md", size: 20, modifiedMs: 100, sha256: "r1" },
    );
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");
    expect(state.extractedFiles.sort()).toEqual(["src/added.py", "src/util.ts"]); // 只重提变化文件
    const status = await manager.status("s1", CWD);
    expect(status.files).toBe(3);
    // 删除文件的符号已清除；新文件符号可搜
    expect(await manager.searchSymbols(CWD, "top_level")).toEqual([]);
    expect((await manager.searchSymbols(CWD, "added_fn"))[0]).toMatchObject({ kind: "function", path: "src/added.py" });
  });

  it("未建索引时 searchSymbols 拒绝并指引显式重建", async () => {
    const root = await tempRoot("owc-index-");
    const { core } = createFakeScanCore({ manifest: [], symbols: {}, watchMode: "fail" });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await expect(manager.searchSymbols(CWD, "x")).rejects.toThrow(IndexUnavailableError);
    await expect(manager.searchSymbols(CWD, "x")).rejects.toThrow(/has not been built/);
  });

  it("重建进行中再次 rebuild 报 INDEX_BUILDING", async () => {
    const root = await tempRoot("owc-index-");
    const { core } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail", neverFinish: true });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await expect(manager.rebuild("s1", CWD)).rejects.toThrow(/already running/);
    await manager.cancel("s1", CWD);
  });

  it("取消重建：保留旧状态、如实标滞后（cancelled）", async () => {
    const root = await tempRoot("owc-index-");
    const { core, state } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail", neverFinish: true });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "building");
    expect(await manager.cancel("s1", CWD)).toBe(true);
    await waitFor(async () => (await manager.status("s1", CWD)).status !== "building");
    expect(state.cancelCalls).toHaveLength(1);
    const status = await manager.status("s1", CWD);
    expect(status.status).not.toBe("building");
    expect(status.staleReason).toBe("cancelled");
  });

  it("索引损坏（JSONL 解析失败）整体作废，可显式重建恢复", async () => {
    const root = await tempRoot("owc-index-");
    const { core } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail" });
    const indexRoot = path.join(root, "index");
    const first = createManager(core, indexRoot, new EventBus());
    await first.rebuild("s1", CWD);
    await waitFor(async () => (await first.status("s1", CWD)).status === "fresh");

    // 写入垃圾行破坏 files.jsonl，新实例加载应判损坏并整体作废
    const dir = path.join(indexRoot, workspaceHash(CWD));
    await writeFile(path.join(dir, "files.jsonl"), "this is not json\n");
    const second = createManager(core, indexRoot, new EventBus());
    const corrupted = await second.status("s1", CWD);
    expect(corrupted.status).toBe("missing");
    expect(corrupted.staleReason).toBe("corrupt");
    await expect(second.searchSymbols(CWD, "getTop")).rejects.toThrow(/corrupt/);

    // 显式重建后恢复
    await second.rebuild("s1", CWD);
    await waitFor(async () => (await second.status("s1", CWD)).status === "fresh");
    expect(await second.searchSymbols(CWD, "getTop")).toHaveLength(1);
  });

  it("watch 不可用时降级 turn 边界 mtime 抽样：样本变化标滞后", async () => {
    const root = await tempRoot("owc-index-");
    const stats = new Map(BASE_MANIFEST.map((entry) => [entry.path, { size: entry.size, modifiedMs: entry.modifiedMs }]));
    const { core } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail", stats });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");

    // 抽样未变：保持 fresh
    await manager.noteTurnBoundary("s1", CWD);
    expect((await manager.status("s1", CWD)).status).toBe("fresh");
    // 样本 mtime 变化：标滞后（不自动重建，重建是显式动作）
    stats.set("src/util.ts", { size: UTIL_TS.length, modifiedMs: 999 });
    await manager.noteTurnBoundary("s1", CWD);
    const status = await manager.status("s1", CWD);
    expect(status.status).toBe("stale");
    expect(status.staleReason).toBe("mtime");
  });

  it("watch 激活时 watch 事件驱动标滞后", async () => {
    const root = await tempRoot("owc-index-");
    const { core, state } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "active" });
    const manager = createManager(core, path.join(root, "index"), new EventBus(), { watchPollMs: 5 });
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");
    expect((await manager.status("s1", CWD)).watch).toBe("active");

    state.pollEvents.push({ path: "src/util.ts", kind: "changed" });
    await waitFor(async () => (await manager.status("s1", CWD)).status === "stale");
    expect((await manager.status("s1", CWD)).staleReason).toBe("watch");
  });

  it("extract 截断（summary.truncated）时未输出文件保留旧符号并打 warn，不静默清空", async () => {
    const root = await tempRoot("owc-index-");
    // 本地 manifest/symbols：避免与其他用例共享可变的 BASE_* 全局
    const manifest: IndexScanEntry[] = [
      { path: "src/util.ts", size: UTIL_TS.length, modifiedMs: 100, sha256: "u1" },
      { path: "README.md", size: 20, modifiedMs: 100, sha256: "r1" },
    ];
    const symbols: Record<string, SymbolRecord[]> = {
      "src/util.ts": [
        { name: "getTopSymbols", kind: "function", startLine: 1, endLine: 3, signature: "export function getTopSymbols(list: string[]): string {" },
      ],
    };
    const { core, state } = createFakeScanCore({ manifest, symbols, watchMode: "fail" });
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");
    expect(await manager.searchSymbols(CWD, "getTop")).toHaveLength(1);

    const stderrChunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      // 第二轮：util.ts 变化 + 新增 added.py；extract 只输出 added.py，summary.truncated=true
      const addedPy = "def added_fn():\n    pass\n";
      symbols["src/added.py"] = [
        { name: "added_fn", kind: "function", startLine: 1, endLine: 2, signature: "def added_fn():" },
      ];
      manifest.splice(0, manifest.length,
        { path: "src/util.ts", size: UTIL_TS.length, modifiedMs: 200, sha256: "u2" },
        { path: "src/added.py", size: addedPy.length, modifiedMs: 200, sha256: "a1" },
        { path: "README.md", size: 20, modifiedMs: 100, sha256: "r1" },
      );
      state.skipExtractFiles = ["src/util.ts"];
      state.extractSummary = { truncated: true, reason: "time" };
      await manager.rebuild("s1", CWD);
      await waitFor(async () => (await manager.status("s1", CWD)).status === "fresh");

      // util.ts 旧符号保留（不清空）；added.py 新符号正常入库
      expect(await manager.searchSymbols(CWD, "getTop")).toHaveLength(1);
      expect((await manager.searchSymbols(CWD, "added_fn"))[0]).toMatchObject({ kind: "function", path: "src/added.py" });
      // warn 日志含 reason 与跳过文件数
      expect(stderrChunks.some((chunk) => chunk.includes("index.extract") && chunk.includes("time") && chunk.includes("1 个文件"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("jobOutput truncated（core 输出 ring 溢出）：runScan 走 error/stale 而非静默成功", async () => {
    const root = await tempRoot("owc-index-");
    const { core, state } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail" });
    state.outputTruncated = true;
    const manager = createManager(core, path.join(root, "index"), new EventBus());
    await manager.rebuild("s1", CWD);
    await waitFor(async () => (await manager.status("s1", CWD)).status !== "building");
    const status = await manager.status("s1", CWD);
    expect(status.status).toBe("missing"); // 从未成功建过索引
    expect(status.staleReason).toBe("error");
  });
});

describe("code_search 工具（agent 级）", () => {
  async function setup(withIndex: boolean) {
    const root = await tempRoot("owc-index-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "fake-model" });
    await sessions.updatePermissions(session.id, "acceptEdits", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const { core } = createFakeScanCore({ manifest: BASE_MANIFEST, symbols: BASE_SYMBOLS, watchMode: "fail" });
    const events = new EventBus();
    const providers = new ProviderRegistry();
    let turn = 0;
    const toolsSeen: string[][] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        toolsSeen.push(request.tools.map((tool) => tool.name));
        if (turn++ === 0) {
          yield { type: "tool_call", id: "cs-1", name: "code_search", input: { query: "getTop" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    providers.register(provider);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);
    const manager = createManager(core, path.join(root, "index"), events);
    runner.setIndexManager(manager);
    if (withIndex) {
      // 会话 cwd 是 root，索引按 cwd 分桶；先用同一会话 cwd 建索引
      await manager.rebuild(session.id, root);
      await waitFor(async () => (await manager.status(session.id, root)).status === "fresh");
    }
    return { sessions, session, runner, toolsSeen };
  }

  it("索引可用：code_search 返回 文件:行 + 种类 + 签名摘要", async () => {
    const { sessions, session, runner, toolsSeen } = await setup(true);
    await runner.run(session.id, "find getTop");
    expect(toolsSeen[0]).toContain("code_search");
    const detail = await sessions.get(session.id);
    const toolMessage = detail?.messages.find((message) => message.role === "tool");
    const text = toolMessage?.content.map((block) => (block.type === "tool_result" ? block.content : "")).join("\n") ?? "";
    expect(text).toContain("src/util.ts:1");
    expect(text).toContain("function");
    expect(text).toContain("getTopSymbols");
    expect(text).not.toContain("isError");
  });

  it("索引未建：明确错误并指引退回 grep/glob，不自动触发重建", async () => {
    const { sessions, session, runner } = await setup(false);
    await runner.run(session.id, "find getTop");
    const detail = await sessions.get(session.id);
    const toolMessage = detail?.messages.find((message) => message.role === "tool");
    const text = toolMessage?.content.map((block) => (block.type === "tool_result" ? block.content : "")).join("\n") ?? "";
    expect(text).toContain("Fall back to grep/glob");
    const toolResult = toolMessage?.content.find((block) => block.type === "tool_result");
    expect((toolResult as { isError?: boolean } | undefined)?.isError).toBe(true);
  });
});

describe("languageForPath（提取候选过滤）", () => {
  it("覆盖主要语言扩展名并拒绝未知扩展", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("src/a.tsx")).toBe("typescript");
    expect(languageForPath("src/a.jsx")).toBe("javascript");
    expect(languageForPath("pkg/main.go")).toBe("go");
    expect(languageForPath("src/lib.rs")).toBe("rust");
    expect(languageForPath("src/x.h")).toBe("c");
    expect(languageForPath("src/x.hpp")).toBe("cpp");
    expect(languageForPath("App.java")).toBe("java");
    expect(languageForPath("Program.cs")).toBe("csharp");
    expect(languageForPath("README.md")).toBeUndefined();
    expect(languageForPath("Makefile")).toBeUndefined();
  });
});
