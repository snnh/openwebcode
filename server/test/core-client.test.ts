import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { CORE_PROTOCOL_VERSION, CoreGateway, CoreProtocolError, negotiate } from "../src/core-gateway.js";
import { CoreLogArchive } from "../src/core-log.js";
import { CoreClient, CoreRpcError, sanitizedCoreEnv, type CoreEvent, type CoreInfo, type IndexScanEntry, type IndexScanSummary } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { IndexManager } from "../src/index/index-manager.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { encodeFrame, FrameDecoder } from "../src/rpc/frame-codec.js";
import { TcpTransport } from "../src/rpc/transport.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const coreExists = existsSync(corePath);
const itIfCore = coreExists ? it : it.skip;

let client: CoreClient | undefined;
let server: Server | undefined;
let child: ChildProcess | undefined;
let manager: IndexManager | undefined;

afterEach(async () => {
  manager?.stop();
  manager = undefined;
  await client?.stop().catch(() => undefined);
  client = undefined;
  if (child && child.exitCode === null) child.kill();
  child = undefined;
  server?.close();
  server = undefined;
});

describe("sanitizedCoreEnv", () => {
  it("Windows 前置 System32（去重），其他平台返回 undefined", () => {
    const env = sanitizedCoreEnv();
    if (process.platform !== "win32") {
      expect(env).toBeUndefined();
      return;
    }
    const key = Object.keys(env!).find((candidate) => candidate.toLowerCase() === "path")!;
    const entries = env![key]!.split(";").filter((entry) => entry.length > 0);
    const systemRoot = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
    // 前三位固定为 System32 / 系统根 / Wbem，保证 find/sort 等解析为 Windows 版本
    expect(entries[0]!.toLowerCase()).toBe(path.join(systemRoot, "system32"));
    expect(entries[1]!.toLowerCase()).toBe(systemRoot);
    expect(entries[2]!.toLowerCase()).toBe(path.join(systemRoot, "system32", "wbem"));
    // 不重复前置；原有条目保留（MSYS usr\bin 仍在，只是排在 System32 之后）
    expect(entries.filter((entry) => entry.toLowerCase() === entries[0]!.toLowerCase())).toHaveLength(1);
    expect(entries.length).toBeGreaterThan(3);
  });
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

    const workspace = await tempRoot("owc-index-scan-");
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

  /** 通过真实 CoreClient 驱动 startGrepJob/startGlobJob（Node->core 真链路）。 */
  it("runs grep/glob jobs through the real core with determinism, budgets and cancellation", async () => {
    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.grepJob).toBe(true);
    expect(info.features?.globJob).toBe(true);

    const workspace = await tempRoot("owc-search-job-");
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

describe("CoreClient crash recovery", () => {
  it("keeps retrying with capped backoff instead of giving up after 3 crashes, and kick-starts on demand", async () => {
    const bogus = path.join(tmpdir(), `owc-missing-core-${process.pid}`);
    const recovery = new CoreClient(bogus, 5_000);
    recovery.on("error", () => { /* 重启失败以 error 事件上报，测试中吞掉 */ });
    const exits: CoreEvent[] = [];
    recovery.on("event", (event) => { if (event.type === "core.exit") exits.push(event); });
    await expect(recovery.start()).rejects.toThrow();
    // 旧逻辑 3 次退避后永久放弃（含首次共 4 次尝试）；新逻辑封顶退避持续重试。
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(4), { timeout: 20_000 });
    // 懒重启：core 已死时请求立即拒绝，并即时拉起一次重启（取消排程中的退避等待）
    const before = exits.length;
    await expect(recovery.ping()).rejects.toThrow("Core is not running");
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(before), { timeout: 10_000 });
    await recovery.stop();
  }, 30_000);
});

// ---- frame-codec 组（合并） ----
describe("FrameDecoder", () => {
  it("decodes fragmented and adjacent UTF-8 frames", () => {
    const decoder = new FrameDecoder();
    const messages: unknown[] = [];
    decoder.on("message", (message) => messages.push(message));
    const first = encodeFrame({ text: "你好" });
    const second = encodeFrame({ value: 2 });
    const input = Buffer.concat([first, second]);
    decoder.push(input.subarray(0, 7));
    decoder.push(input.subarray(7, first.length + 3));
    decoder.push(input.subarray(first.length + 3));
    expect(messages).toEqual([{ text: "你好" }, { value: 2 }]);
  });

  it("rejects duplicate Content-Length headers", () => {
    const decoder = new FrameDecoder();
    const errors: Error[] = [];
    decoder.on("error", (error) => errors.push(error));
    decoder.push(Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"));
    expect(errors[0]?.message).toContain("Duplicate");
  });

  it("rejects a complete oversized header", () => {
    const decoder = new FrameDecoder();
    const errors: Error[] = [];
    decoder.on("error", (error) => errors.push(error));
    decoder.push(Buffer.from(`X-Fill: ${"x".repeat(8192)}\r\nContent-Length: 2\r\n\r\n{}`));
    expect(errors[0]?.message).toContain("header exceeds");
  });

  it("keeps the 32 MiB core frame boundary and rejects larger declarations", () => {
    const atLimit = new FrameDecoder();
    const acceptedErrors: Error[] = [];
    atLimit.on("error", (error) => acceptedErrors.push(error));
    // No body yet: a legal maximum declaration remains buffered rather than
    // rejected, which avoids allocating a synthetic 32 MiB test payload.
    atLimit.push(Buffer.from("Content-Length: 33554432\r\n\r\n"));
    expect(acceptedErrors).toEqual([]);

    const overLimit = new FrameDecoder();
    const errors: Error[] = [];
    overLimit.on("error", (error) => errors.push(error));
    overLimit.push(Buffer.from("Content-Length: 33554433\r\n\r\n"));
    expect(errors[0]?.message).toContain("32 MiB");
  });
});

// ---- core-gateway 组（合并） ----
function coreInfo(overrides: Partial<CoreInfo> = {}): CoreInfo {
  return {
    version: "0.2.4",
    protocolVersion: CORE_PROTOCOL_VERSION,
    platform: "windows",
    sandboxCapability: "enforced",
    features: {
      fsStat: true,
      fsStatMany: true,
      fsWriteBase64: true,
      jobControl: true,
      fsHash: true,
      fsScanPagination: true,
      fsWatch: true,
    },
    limits: {
      maxFrameBytes: 33_554_432,
      maxWriteBase64Bytes: 20_971_520,
      maxHashBytes: 16_777_216,
      maxStatManyPaths: 128,
      maxStatManyPathBytes: 262_144,
      maxScanEntries: 256,
      maxScanDepth: 16,
      maxScanNodes: 2_048,
      maxWatches: 16,
      maxWatchEvents: 128,
      maxConcurrentJobs: 4,
      maxJobOutputBytes: 524_288,
    },
    ...overrides,
  };
}

describe("CoreGateway", () => {
  it("negotiates once and only exposes explicitly advertised features", async () => {
    const ping = vi.fn(async () => coreInfo({ features: { ...coreInfo().features!, jobControl: false } }));
    const gateway = new CoreGateway({ ping });

    await expect(gateway.supports("jobControl")).resolves.toBe(false);
    await expect(gateway.supports("fsWatch")).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("rejects an incompatible protocol instead of falling back to probe calls", () => {
    expect(() => negotiate(coreInfo({ protocolVersion: "0.9" }))).toThrow(CoreProtocolError);
  });

  it("rejects incomplete limits and feature records", () => {
    expect(() => negotiate(coreInfo({ features: { ...coreInfo().features!, fsWatch: undefined as never } }))).toThrow("features.fsWatch");
    expect(() => negotiate(coreInfo({ limits: { ...coreInfo().limits!, maxConcurrentJobs: 0 } }))).toThrow("limits.maxConcurrentJobs");
  });

  it("协商失败的 Promise 不缓存：下次调用重新 ping 并可成功", async () => {
    let calls = 0;
    const ping = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("core not ready");
      return coreInfo();
    });
    const gateway = new CoreGateway({ ping });

    await expect(gateway.info()).rejects.toThrow("core not ready");
    // 失败后缓存已清空，第二次调用触发新一轮协商并成功
    await expect(gateway.info()).resolves.toMatchObject({ protocolVersion: CORE_PROTOCOL_VERSION });
    expect(ping).toHaveBeenCalledTimes(2);
    // 成功结果被缓存，不再重复 ping
    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("invalidate 后重新协商（core 重启/ready 路径刷新能力快照）", async () => {
    const ping = vi.fn(async () => coreInfo());
    const gateway = new CoreGateway({ ping });

    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(1);
    gateway.invalidate();
    await gateway.info();
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe("CoreGateway 接线（AgentRunner core.ready）", () => {
  it("core.ready 事件使协商缓存失效，下一次能力判定重新 ping", async () => {
    const root = await tempRoot("owc-gw-ready-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const providers = new ProviderRegistry();
    let listener: ((event: CoreEvent) => void) | undefined;
    let pingCount = 0;
    const core = makeFakeCore({
      async ping() { pingCount += 1; return FAKE_CORE_INFO; },
      on(eventName: string, eventListener: (...args: unknown[]) => void) {
        if (eventName === "event") listener = eventListener as (event: CoreEvent) => void;
        return core;
      },
    });
    const agent = new AgentRunner(sessions, providers, core, events, pricing);

    // runShell -> executeBash -> coreGateway.supports("jobControl")：首次协商
    await agent.runShell(session.id, "echo one");
    await agent.runShell(session.id, "echo two");
    expect(pingCount).toBe(1); // 协商结果被缓存
    // core 重启完成重新握手：能力快照失效，下次用到时重新协商
    listener?.({ source: "core", type: "core.ready", payload: FAKE_CORE_INFO });
    await agent.runShell(session.id, "echo three");
    expect(pingCount).toBe(2);
  }, 15_000);
});

// ---- core-log 组（合并） ----
const coreLogRoot = (): Promise<string> => tempRoot("owc-corelog-");

describe("CoreLogArchive", () => {
  it("initialize 创建目录，append 追加写入 core.log", async () => {
    const root = await coreLogRoot();
    const archive = new CoreLogArchive(path.join(root, "logs"));
    await archive.initialize();
    archive.append("[owc-exec] first\n");
    archive.append("[owc-exec] second\n");
    await vi.waitFor(async () => {
      expect(await readFile(path.join(root, "logs", "core.log"), "utf8")).toBe("[owc-exec] first\n[owc-exec] second\n");
    });
  });

  it("超过阈值的 core.log 在 initialize 时轮转为 core.log.1（只保留一代）", async () => {
    const root = await coreLogRoot();
    const logDir = path.join(root, "logs");
    const archive = new CoreLogArchive(logDir, 16);
    await archive.initialize();
    await writeFile(path.join(logDir, "core.log"), "x".repeat(32), "utf8");
    await writeFile(path.join(logDir, "core.log.1"), "previous-generation", "utf8");
    await archive.initialize();
    expect(await readFile(path.join(logDir, "core.log.1"), "utf8")).toBe("x".repeat(32));
    // core.log 已被轮转走，append 后重新创建
    archive.append("fresh\n");
    await vi.waitFor(async () => {
      expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("fresh\n");
    });
  });

  it("未超阈值不轮转", async () => {
    const root = await coreLogRoot();
    const logDir = path.join(root, "logs");
    const archive = new CoreLogArchive(logDir, 1024);
    await archive.initialize();
    await writeFile(path.join(logDir, "core.log"), "small\n", "utf8");
    await archive.initialize();
    expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("small\n");
    await expect(stat(path.join(logDir, "core.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("append 失败静默吞掉（未 initialize 目录不存在也不抛错）", async () => {
    const root = await coreLogRoot();
    const archive = new CoreLogArchive(path.join(root, "missing", "logs"));
    archive.append("dropped\n");
    // 不抛错即通过；给 appendFile 一个失败的机会
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe.skipIf(!existsSync(corePath))("CoreClient fs.readBase64", () => {
  async function start(): Promise<{ cwd: string }> {
    const cwd = await tempRoot("owc-read-base64-");
    client = new CoreClient(corePath);
    const info = await client.start();
    // 六方同步面：新 core 必须上报 fs.readBase64 能力与读取上限
    expect(info.features?.fsReadBase64).toBe(true);
    expect(info.limits?.maxReadBase64Bytes).toBe(20 * 1024 * 1024);
    await client.configureSession({
      sessionId: "test-session",
      cwd,
      sandbox: { enabled: false, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: "allow" },
    });
    return { cwd };
  }

  it("roundtrips binary bytes including NUL and 0xFF", async () => {
    const { cwd } = await start();
    const blob = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0x00, 0xff, 0xfe, 0x00])]);
    await writeFile(path.join(cwd, "blob.bin"), blob);
    const result = await client!.readFileBase64!({ sessionId: "test-session", path: "blob.bin" });
    expect(result.truncated).toBe(false);
    expect(result.size).toBe(blob.length);
    expect(Buffer.from(result.base64, "base64")).toEqual(blob);
  });

  it("roundtrips through writeFileBase64", async () => {
    await start();
    const blob = Buffer.from("pretend-png-bytes\x00\x89PNG", "binary");
    await client!.writeFileBase64!({ sessionId: "test-session", path: "image.png", data: blob.toString("base64") });
    const result = await client!.readFileBase64!({ sessionId: "test-session", path: "image.png" });
    expect(result.truncated).toBe(false);
    expect(Buffer.from(result.base64, "base64")).toEqual(blob);
  });

  it("maps a missing file to the stable -32003 error", async () => {
    await start();
    const failure = await client!.readFileBase64!({ sessionId: "test-session", path: "missing.bin" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreRpcError);
    expect((failure as CoreRpcError).code).toBe(-32003);
  });
});

describe.skipIf(!existsSync(corePath))("owc-exec --connect TCP loopback", () => {
  itIfCore("handshakes core.ping over the connect-back socket", async () => {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind a port");
    const socketPromise = new Promise<Socket>((resolve) => server!.once("connection", resolve));
    child = spawn(corePath, ["--connect", `127.0.0.1:${address.port}`], { windowsHide: true });
    const socket = await socketPromise;
    // 复用 CoreClient 的外部连接注入：传输为回连 TCP socket，完成真实握手
    client = new CoreClient(corePath, 10_000, () => Promise.resolve({ transport: new TcpTransport(socket) }));
    const info = await client.start();
    expect(["windows", "linux", "darwin"]).toContain(info.platform);
    expect(info.sandboxCapability).toBeTruthy();
    await client.stop();
    client = undefined;
    // core.shutdown 后进程应自行退出
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null) return resolve();
      child!.once("exit", () => resolve());
      setTimeout(resolve, 5_000);
    });
    expect(child.exitCode).toBe(0);
  }, 30_000);

  itIfCore("rejects invalid arguments with usage on stderr and exit code 2", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const proc = spawn(corePath, ["--bogus"], { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.once("exit", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  }, 15_000);

  itIfCore("fails to connect with a non-zero exit code", async () => {
    // 在空闲端口上连接应立即失败
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind a port");
    server.close();
    server = undefined;
    const code = await new Promise<number | null>((resolve) => {
      child = spawn(corePath, ["--connect", `127.0.0.1:${address.port}`], { windowsHide: true });
      child.once("exit", resolve);
    });
    expect(code).toBe(1);
  }, 15_000);
});

describe.skipIf(!existsSync(corePath))("IndexManager against real core (base64 job.output)", () => {
  it("runs a real index.scan + index.extract and finds files and symbols", async () => {
    const workspace = await tempRoot("owc-index-e2e-ws-");
    const indexRoot = await tempRoot("owc-index-e2e-idx-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "util.ts"), "export function helperFn(): number {\n  return 1;\n}\n");
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const betaValue = 2;\n");

    client = new CoreClient(corePath);
    const info = await client.start();
    expect(info.features?.indexScan).toBe(true);
    expect(info.features?.indexExtract).toBe(true);
    await client.configureSession({
      sessionId: "index-e2e",
      cwd: workspace,
      sandbox: { enabled: false, readRoots: [workspace], writeRoots: [workspace], denyPaths: [], network: "allow" },
    });

    manager = new IndexManager(client, indexRoot, new EventBus(), { pollMs: 20, autoRefresh: false });
    await manager.rebuild("index-e2e", workspace);
    let status = await manager.status("index-e2e", workspace);
    for (let attempt = 0; status.status === "building" && attempt < 400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await manager.status("index-e2e", workspace);
    }
    // base64 解码回归：修复前这里会因 JSONL 解析出 base64 垃圾而 error/stale
    expect(status.status).toBe("fresh");
    expect(status.files).toBe(2);

    const symbols = await manager.searchSymbols(workspace, "helperFn");
    expect(symbols.some((hit) => hit.path === "src/util.ts" && hit.kind === "function")).toBe(true);

    const files = await manager.searchFiles(workspace, "main");
    expect(files.some((hit) => hit.path === "src/main.ts")).toBe(true);
  }, 30_000);
});
