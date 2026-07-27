import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, type CoreEvent, type IndexScanEntry, type IndexScanSummary } from "../src/core-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
let client: CoreClient | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

describe.skipIf(!existsSync(corePath))("CoreClient", () => {
  it("handshakes and executes through the real core", async () => {
    client = new CoreClient(corePath);
    const events: CoreEvent[] = [];
    client.on("event", (event) => events.push(event));
    const info = await client.start();
    expect(["windows", "linux", "darwin"]).toContain(info.platform);

    const cwd = path.resolve(here, "../..");
    await client.configureSession({
      sessionId: "test-session",
      cwd,
      sandbox: {
        enabled: false,
        readRoots: [cwd],
        writeRoots: [cwd],
        denyPaths: [],
        network: "allow",
      },
    });
    const result = await client.run({
      sessionId: "test-session",
      execId: "test-exec",
      cmd: process.platform === "win32"
        ? "Write-Output node-core-ok; [Console]::Error.WriteLine('node-core-error'); exit 7"
        : "printf 'node-core-ok\\n'; printf 'node-core-error\\n' >&2; exit 7",
      cwd,
      timeoutMs: 15_000,
      shellBackend: process.platform === "win32" ? "pwsh" : "default",
    });
    expect(result.exitCode).toBe(7);
    const output = events.filter((event) => event.type === "exec.output");
    expect(output).toHaveLength(2);

    if (process.platform === "win32") {
      const hostedWindows = process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
      await client.configureSession({
        sessionId: "test-session",
        cwd,
        sandbox: {
          enabled: true,
          readRoots: [cwd],
          writeRoots: [cwd],
          denyPaths: [],
          network: "deny",
        },
      });
      const directoryResult = await client.run({
        sessionId: "test-session",
        execId: hostedWindows ? "test-cmd-directory" : "test-pwsh-directory",
        // GitHub-hosted Windows runners retain/fail AppContainer pwsh children
        // inconsistently. Non-sandbox pwsh is covered above; keep the hosted
        // sandbox integration on cmd and exercise sandbox+pwsh locally.
        cmd: hostedWindows
          ? "if exist server\\package.json (exit /b 0) else (exit /b 1)"
          : "Get-ChildItem -Name | Select-Object -First 1",
        cwd,
        timeoutMs: 15_000,
        shellBackend: hostedWindows ? "default" : "pwsh",
      });
      expect(directoryResult.exitCode).toBe(0);
      await expect(client.ping()).resolves.toMatchObject({ platform: "windows" });
    }
  }, 30_000);

  it("runs an index.scan job and pages its JSONL manifest", async () => {
    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.indexScan).toBe(true);

    const workspace = mkdtempSync(path.join(tmpdir(), "owc-index-scan-"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(workspace, "b.md"), "# b\n");
    writeFileSync(path.join(workspace, "debug.log"), "noise\n");
    await client.configureSession({
      sessionId: "index-session",
      cwd: workspace,
      sandbox: { enabled: false, readRoots: [workspace], writeRoots: [workspace], denyPaths: [], network: "allow" },
    });

    const started = await client.startIndexScan({
      sessionId: "index-session",
      jobId: "scan-1",
      kind: "index.scan",
      cwd: workspace,
      path: ".",
      exclude: ["*.log"],
    });
    expect(started.state).toBe("running");

    let status = await client.jobStatus({ sessionId: "index-session", jobId: "scan-1" });
    for (let attempt = 0; status.state === "running" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await client.jobStatus({ sessionId: "index-session", jobId: "scan-1" });
    }
    expect(status.state).toBe("completed");

    const chunks: string[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await client.jobOutput({ sessionId: "index-session", jobId: "scan-1", afterSeq, limit: 1 });
      chunks.push(...page.chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString("utf8")));
      if (page.nextSeq === afterSeq) break;
      afterSeq = page.nextSeq;
    }
    const lines = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    const summary = lines.pop() as { summary: IndexScanSummary };
    const entries = lines as IndexScanEntry[];
    expect(summary.summary).toEqual({ entries: 2, truncated: false, reason: null, hashTruncated: false });
    expect(entries.map((entry) => entry.path)).toEqual(["b.md", "src/a.ts"]);
    expect(entries[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1].modifiedMs).toBeGreaterThan(0);
  }, 30_000);

  /** 0.5.0 Phase 2c：通过真实 CoreClient 驱动 startGrepJob/startGlobJob（Node->core 真链路）。 */
  it("runs grep/glob jobs through the real core with determinism, budgets and cancellation", async () => {
    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.grepJob).toBe(true);
    expect(info.features?.globJob).toBe(true);

    const workspace = mkdtempSync(path.join(tmpdir(), "owc-search-job-"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const main = 1;\nconst beta = 2;\n");
    writeFileSync(path.join(workspace, "src", "util.ts"), "export const util = 2;\nconst beta = 3;\n");
    writeFileSync(path.join(workspace, "docs.md"), "# guide\nbeta reference\n");
    await client.configureSession({
      sessionId: "search-session",
      cwd: workspace,
      sandbox: { enabled: false, readRoots: [workspace], writeRoots: [workspace], denyPaths: [], network: "allow" },
    });

    const drain = async (jobId: string): Promise<{ lines: unknown[]; summary: { truncated: boolean; reason: string | null } }> => {
      let status = await client!.jobStatus({ sessionId: "search-session", jobId });
      for (let attempt = 0; status.state === "running" && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await client!.jobStatus({ sessionId: "search-session", jobId });
      }
      expect(status.state).toBe("completed");
      const chunks: string[] = [];
      let afterSeq = 0;
      for (;;) {
        const page = await client!.jobOutput({ sessionId: "search-session", jobId, afterSeq, limit: 64 });
        chunks.push(...page.chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString("utf8")));
        if (page.nextSeq === afterSeq) break;
        afterSeq = page.nextSeq;
      }
      const parsed = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
      const summary = parsed.pop() as { summary: { truncated: boolean; reason: string | null } };
      return { lines: parsed, summary: summary.summary };
    };

    // grep: 找到 beta 全部匹配，按 path/line 排序
    await client.startGrepJob({
      sessionId: "search-session", jobId: "grep-1", kind: "grep", cwd: workspace, path: ".", pattern: "beta",
    });
    const first = await drain("grep-1");
    const keys = (first.lines as Array<{ path: string; line: number }>).map((m) => [m.path, m.line]);
    expect(keys).toEqual([...keys].sort());
    expect(first.summary.truncated).toBe(false);
    expect((first.lines as Array<{ path: string }>).some((m) => m.path === "src/main.ts")).toBe(true);

    // 确定性：第二次 grep 结果完全一致
    await client.startGrepJob({
      sessionId: "search-session", jobId: "grep-2", kind: "grep", cwd: workspace, path: ".", pattern: "beta",
    });
    const again = await drain("grep-2");
    expect(again.lines).toEqual(first.lines);
    expect(again.summary).toEqual(first.summary);

    // glob: 匹配 .ts 路径，排序
    await client.startGlobJob({
      sessionId: "search-session", jobId: "glob-1", kind: "glob", cwd: workspace, path: ".", pattern: "*.ts",
    });
    const glob = await drain("glob-1");
    const paths = (glob.lines as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toEqual(["src/main.ts", "src/util.ts"]);
    expect(glob.summary.truncated).toBe(false);

    // 预算截断：maxNodes=1 必定截断
    await client.startGlobJob({
      sessionId: "search-session", jobId: "glob-budget", kind: "glob", cwd: workspace, path: ".", pattern: "*", maxNodes: 1,
    });
    const budget = await drain("glob-budget");
    expect(budget.summary.truncated).toBe(true);
    expect(budget.summary.reason).toBe("nodes");

    // 取消语义：cancelJob 可取消一个运行中的 job。
    // 小工作区会在 cancel 到达前就完成（竞态，Linux CI 上出现过），因此先在
    // bulk/ 下铺足够多的文件，保证 grep 在 cancel 处理完之前必定仍在运行。
    mkdirSync(path.join(workspace, "bulk"));
    for (let i = 0; i < 3000; i += 1) {
      writeFileSync(path.join(workspace, "bulk", `f${i}.txt`), `beta line ${i}\n`);
    }
    await client.startGrepJob({
      sessionId: "search-session", jobId: "grep-cancel", kind: "grep", cwd: workspace, path: "bulk", pattern: "beta",
    });
    const cancelled = await client.cancelJob({ sessionId: "search-session", jobId: "grep-cancel" });
    expect(cancelled).toEqual({ jobId: "grep-cancel", accepted: true });
    let status = await client.jobStatus({ sessionId: "search-session", jobId: "grep-cancel" });
    for (let attempt = 0; status.state === "running" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await client.jobStatus({ sessionId: "search-session", jobId: "grep-cancel" });
    }
    expect(status.state).toBe("cancelled");
  }, 30_000);
});
