import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoMapGenerator } from "../src/context/repo-map.js";
import type { CoreClientLike, IndexScanEntry } from "../src/core-client.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import type { RepoMapSymbolFile } from "../src/index/index-manager.js";
import { makeFakeScanCore } from "./helpers/fake-scan-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const managers: IndexManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

const FILES = ["package.json", "src/app.ts", "src/util.ts", "docs/guide.md"];

describe("repo_map 索引形态（Phase 2 §4.1）", () => {
  it("索引可用：关键文件附符号摘要，按最近修改优先", async () => {
    const generator = new RepoMapGenerator(makeFakeScanCore(FILES));
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
    const generator = new RepoMapGenerator(makeFakeScanCore(FILES));
    generator.setSymbolProvider(() => Promise.resolve(undefined));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).not.toContain("Key files with symbols");
    expect(result.text).toContain("src/");
  });

  it("索引查询抛错：同样降级静态树，不阻断生成", async () => {
    const generator = new RepoMapGenerator(makeFakeScanCore(FILES));
    generator.setSymbolProvider(() => Promise.reject(new Error("index broken")));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).not.toContain("Key files with symbols");
    expect(result.text).toContain("src/");
  });

  it("端到端：真实 IndexManager 建索引后 repo map 带符号，未建时降级", async () => {
    const root = await tempRoot("owc-repomap-idx-");
    const utilTs = "export function helperFn(): void {\n}\n";
    const manifest: IndexScanEntry[] = [{ path: "src/util.ts", size: utilTs.length, modifiedMs: 100, sha256: "u1" }];
    const jsonl = manifest.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
      + JSON.stringify({ summary: { entries: 1, truncated: false, reason: null, hashTruncated: false } }) + "\n";
    const extractJsonl = JSON.stringify({
      path: "src/util.ts",
      symbols: [{ name: "helperFn", kind: "function", startLine: 1, endLine: 2, signature: "export function helperFn(): void {" }],
    }) + "\n" + JSON.stringify({ summary: { files: 1, symbols: 1, truncated: false, reason: null } }) + "\n";
    const servedJobs = new Set<string>();
    const treeCore = makeFakeScanCore(FILES);
    const core = {
      ...treeCore,
      on() { return this; },
      async startIndexScan(request: { jobId: string }) { servedJobs.delete(request.jobId); return { jobId: request.jobId, state: "running" as const }; },
      async startIndexExtract(request: { jobId: string }) { servedJobs.delete(request.jobId); return { jobId: request.jobId, state: "running" as const }; },
      async jobStatus(request: { jobId: string }) { return { jobId: request.jobId, state: "completed" as const }; },
      async jobOutput(request: { jobId: string; afterSeq: number }) {
        if (request.afterSeq !== 0 || servedJobs.has(request.jobId)) {
          return { chunks: [], nextSeq: request.afterSeq, truncated: false };
        }
        servedJobs.add(request.jobId);
        // job.output 的 chunk.data 按真实 core 协议 base64 编码
        const jsonlText = request.jobId.endsWith("-x") ? extractJsonl : jsonl;
        return { chunks: [{ seq: 1, stream: "stdout" as const, data: Buffer.from(jsonlText, "utf8").toString("base64") }], nextSeq: 2, truncated: false };
      },
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
