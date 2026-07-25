import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoMapGenerator } from "../src/context/repo-map.js";
import type { CoreClientLike, FsScanResult, FsStatResult, IndexScanEntry } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import type { RepoMapSymbolFile } from "../src/index/index-manager.js";

const roots: string[] = [];
const managers: IndexManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** repo map 静态树 fake core（与 repo-map.test.ts 同款）。 */
function createTreeCore(files: string[]): CoreClientLike {
  const entries = [
    ...files.map((p) => ({ path: p, type: "file" as const, size: p.length })),
    ...[...new Set(files.flatMap((p) => {
      const parts = p.split("/");
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    }))].map((p) => ({ path: p, type: "directory" as const, size: 0 })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    on() { return this; },
    setRequestTimeoutMs() {},
    async statFile(): Promise<FsStatResult> { return { type: "directory", size: 0, modifiedMs: 1 }; },
    async scanFiles(request: { cursor?: number; limit?: number }): Promise<FsScanResult> {
      const start = request.cursor ?? 0;
      const limit = request.limit ?? 1000;
      const page = entries.slice(start, start + limit);
      const next = start + limit < entries.length ? start + limit : undefined;
      return { entries: page, truncated: false, ...(next === undefined ? {} : { nextCursor: next }) };
    },
  } as unknown as CoreClientLike;
}

const FILES = ["package.json", "src/app.ts", "src/util.ts", "docs/guide.md"];

describe("repo_map 索引形态（Phase 2 §4.1）", () => {
  it("索引可用：关键文件附符号摘要，按最近修改优先", async () => {
    const generator = new RepoMapGenerator(createTreeCore(FILES));
    const symbolFiles: RepoMapSymbolFile[] = [
      { path: "src/util.ts", modifiedMs: 100, symbols: [{ name: "helperFn", kind: "function" }] },
      { path: "src/app.ts", modifiedMs: 200, symbols: [{ name: "bootstrap", kind: "function" }, { name: "App", kind: "class" }] },
    ];
    generator.setSymbolProvider(() => Promise.resolve(symbolFiles));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).toContain("Key files with symbols (recent first):");
    // 最近修改优先：app.ts (mtime 200) 排在 util.ts (mtime 100) 前
    const appIndex = result.text.indexOf("src/app.ts: bootstrap, App");
    const utilIndex = result.text.indexOf("src/util.ts: helperFn");
    expect(appIndex).toBeGreaterThan(-1);
    expect(utilIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeLessThan(utilIndex);
    // 静态树部分仍在
    expect(result.text).toContain("docs/");
  });

  it("索引不可用（undefined）：保持纯静态树降级", async () => {
    const generator = new RepoMapGenerator(createTreeCore(FILES));
    generator.setSymbolProvider(() => Promise.resolve(undefined));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).not.toContain("Key files with symbols");
    expect(result.text).toContain("src/");
  });

  it("索引查询抛错：同样降级静态树，不阻断生成", async () => {
    const generator = new RepoMapGenerator(createTreeCore(FILES));
    generator.setSymbolProvider(() => Promise.reject(new Error("index broken")));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).not.toContain("Key files with symbols");
    expect(result.text).toContain("src/");
  });

  it("端到端：真实 IndexManager 建索引后 repo map 带符号，未建时降级", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-repomap-idx-"));
    roots.push(root);
    const utilTs = "export function helperFn(): void {\n}\n";
    const manifest: IndexScanEntry[] = [{ path: "src/util.ts", size: utilTs.length, modifiedMs: 100, sha256: "u1" }];
    const jsonl = manifest.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
      + JSON.stringify({ summary: { entries: 1, truncated: false, reason: null, hashTruncated: false } }) + "\n";
    let served = false;
    const treeCore = createTreeCore(FILES);
    const core = {
      ...treeCore,
      on() { return this; },
      async startIndexScan() { served = false; return { jobId: "j", state: "running" as const }; },
      async jobStatus() { return { jobId: "j", state: "completed" as const }; },
      async jobOutput(request: { afterSeq: number }) {
        if (request.afterSeq === 0 && !served) {
          served = true;
          return { chunks: [{ seq: 1, stream: "stdout" as const, data: jsonl }], nextSeq: 2, truncated: false };
        }
        return { chunks: [], nextSeq: request.afterSeq, truncated: false };
      },
      async readFile() { return { content: utilTs, totalLines: 2, encoding: "utf-8" as const, truncated: false }; },
      async watchFiles() { throw new Error("fs.watch unavailable"); },
    } as unknown as CoreClientLike;
    const manager = new IndexManager(core, path.join(root, "index"), new EventBus(), { pollMs: 1, autoRefresh: false });
    managers.push(manager);
    const generator = new RepoMapGenerator(core);
    generator.setSymbolProvider((cwd) => manager.symbolSummary(cwd));

    // 未建索引 → 降级
    const before = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(before.text).not.toContain("Key files with symbols");

    // 建索引 → 带符号
    await manager.rebuild("s1", "/repo");
    for (let i = 0; i < 300; i += 1) {
      if ((await manager.status("s1", "/repo")).status === "fresh") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await manager.status("s1", "/repo")).status).toBe("fresh");
    const after = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(after.text).toContain("Key files with symbols (recent first):");
    expect(after.text).toContain("src/util.ts: helperFn");
  });
});
