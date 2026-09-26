import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
// Windows AppContainer 真机能力取决于本机策略；默认不把环境性失败当作回归，
// 显式设置 OWC_RUN_CORE_E2E=1 才执行真实 core 端到端用例。
const itIfCore = coreExists && (process.platform !== "win32" || process.env.OWC_RUN_CORE_E2E === "1") ? it : it.skip;
const describeIfCore = describe.skipIf(!existsSync(corePath));

/** 免沙盒 + 全读写根的会话配置：真机用例的前置 */
function configureSession(target: CoreClient, sessionId: string, cwd: string): Promise<unknown> {
  return target.configureSession({ sessionId, cwd, sandbox: { enabled: false, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: "allow" } });
}

/** 轮询 job 到终态后逐 seq 分页拉取输出，返回状态与解析出的 JSONL 行 */
async function drainJob(target: CoreClient, sessionId: string, jobId: string, limit = 64, attempts = 200) {
  let status = await target.jobStatus({ sessionId, jobId });
  for (let attempt = 0; status.state === "running" && attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = await target.jobStatus({ sessionId, jobId });
  }
  const chunks: string[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await target.jobOutput({ sessionId, jobId, afterSeq, limit });
    chunks.push(...page.chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString("utf8")));
    if (page.nextSeq === afterSeq) break;
    afterSeq = page.nextSeq;
  }
  const lines = chunks.join("").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { state: status.state, lines };
}

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
  it("白名单：保留核心变量（含大小写 proxy 与 Windows 路径变量），剥离 API Key 与访问令牌", () => {
    const keep = {
      PATH: "/usr/bin:/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", SHELL: "/bin/bash", LANG: "zh_CN.UTF-8",
      LC_ALL: "C.UTF-8", LC_MESSAGES: "C", TERM: "xterm-256color", TMPDIR: "/tmp", SSL_CERT_FILE: "/etc/ssl/cert.pem",
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", http_proxy: "http://proxy.local:8080", HTTPS_PROXY: "http://proxy.local:8443",
      no_proxy: "localhost,127.0.0.1", OWC_CORE_VERSION: "9.9.9", SYSTEMROOT: "C:\\WINDOWS", windir: "C:\\WINDOWS",
      Temp: "C:\\Temp", TMP: "C:\\Temp", LocalAppData: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u",
      HOMEDRIVE: "C:", HomePath: "\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    };
    // OWC_* 前缀放行运行时配置，但访问令牌必须剥离（否则沙盒命令 env 可读后假冒 CLI）
    const strip = {
      OWC_ACCESS_TOKEN: "owc-secret-token-0123456789abcdef", ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test",
      AWS_SECRET_ACCESS_KEY: "aws-secret", NODE_ENV: "production", GITHUB_TOKEN: "ghp_test",
    };
    for (const [key, value] of Object.entries({ ...keep, ...strip })) vi.stubEnv(key, value);
    try {
      const env = sanitizedCoreEnv();
      // 大小写不敏感匹配且输出保留原大小写（值可能来自不同大小写来源）
      for (const [key, value] of Object.entries(keep)) {
        if (key === "PATH") continue; expect(Object.entries(env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1], key).toBe(value);
      }
      for (const key of Object.keys(strip)) expect(env[key], key).toBeUndefined();
      // PATH：非 win32 原样保留；win32 前置 System32/系统根/Wbem 且不重复
      const entries = env[Object.keys(env).find((name) => name.toLowerCase() === "path")!]!.split(";").filter(Boolean);
      if (process.platform === "win32") {
        const systemRoot = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
        expect(entries.slice(0, 3).map((entry) => entry.toLowerCase())).toEqual([path.join(systemRoot, "system32"), systemRoot, path.join(systemRoot, "system32", "wbem")]);
        expect(new Set(entries.map((entry) => entry.toLowerCase())).size).toBe(entries.length);
      } else expect(env.PATH).toBe("/usr/bin:/bin");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describeIfCore("CoreClient (real core)", () => {
  it("握手并执行命令：非零退出码与流式输出事件，沙盒策略可切换", async () => {
    client = new CoreClient(corePath);
    const events: CoreEvent[] = [];
    client.on("event", (event) => events.push(event));
    const info = await client.start(); expect(["windows", "linux", "darwin"]).toContain(info.platform);
    const cwd = path.resolve(here, "../..");
    const configure = (enabled: boolean) => client!.configureSession({
      sessionId: "test-session", cwd,
      sandbox: { enabled, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: enabled ? "deny" : "allow" },
    });
    await configure(false);
    const result = await client.run({
      sessionId: "test-session", execId: "test-exec", cwd, timeoutMs: 15_000,
      shellBackend: process.platform === "win32" ? "pwsh" : "default",
      cmd: process.platform === "win32"
        ? "Write-Output node-core-ok; [Console]::Error.WriteLine('node-core-error'); exit 7"
        : "printf 'node-core-ok\\n'; printf 'node-core-error\\n' >&2; exit 7",
    });
    expect(result.exitCode).toBe(7); expect(events.filter((event) => event.type === "exec.output")).toHaveLength(2);
    if (process.platform === "win32") {
      // GitHub-hosted Windows runner 上 AppContainer 内 pwsh 子进程不稳定：托管环境退回 cmd，本地仍覆盖 pwsh
      const hosted = process.env.GITHUB_ACTIONS?.toLowerCase() === "true";
      await configure(true);
      const listed = await client.run({
        sessionId: "test-session", execId: hosted ? "test-cmd-directory" : "test-pwsh-directory",
        cmd: hosted ? "if exist server\\package.json (exit /b 0) else (exit /b 1)" : "Get-ChildItem -Name | Select-Object -First 1",
        cwd, timeoutMs: 15_000, shellBackend: hosted ? "default" : "pwsh",
      });
      expect(listed.exitCode).toBe(0);
      await expect(client.ping()).resolves.toMatchObject({ platform: "windows" });
    }
  }, 30_000);
  it("index.scan job：分页拉取 JSONL manifest，摘要与哈希正确", async () => {
    client = new CoreClient(corePath); expect((await client.start()).features?.indexScan).toBe(true);
    const workspace = await tempRoot("owc-index-scan-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(workspace, "b.md"), "# b\n");
    writeFileSync(path.join(workspace, "debug.log"), "noise\n");
    await configureSession(client, "index-session", workspace);
    expect((await client.startIndexScan({ sessionId: "index-session", jobId: "scan-1", kind: "index.scan", cwd: workspace, path: ".", exclude: ["*.log"] })).state).toBe("running");
    // 逐 seq 分页（limit=1）覆盖跨块拼接路径
    const { state, lines } = await drainJob(client, "index-session", "scan-1", 1); expect(state).toBe("completed");
    const summary = (lines.pop() as { summary: IndexScanSummary }).summary;
    const entries = lines as IndexScanEntry[]; expect(summary).toEqual({ entries: 2, truncated: false, reason: null, hashTruncated: false }); expect(entries.map((entry) => entry.path)).toEqual(["b.md", "src/a.ts"]);
    expect(entries[1]).toMatchObject({ modifiedMs: expect.any(Number) }); expect(entries[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
  it("grep/glob job：结果确定且预算受限，cancelJob 能取消运行中的 job", async () => {
    client = new CoreClient(corePath);
    const info = await client.start(); expect([info.features?.grepJob, info.features?.globJob]).toEqual([true, true]);
    const workspace = await tempRoot("owc-search-job-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const main = 1;\nconst beta = 2;\n");
    writeFileSync(path.join(workspace, "src", "util.ts"), "export const util = 2;\nconst beta = 3;\n");
    writeFileSync(path.join(workspace, "docs.md"), "# guide\nbeta reference\n");
    await configureSession(client, "search-session", workspace);
    const drain = async (jobId: string) => {
      const { state, lines } = await drainJob(client!, "search-session", jobId);
      return { state, lines, summary: (lines.pop() as { summary: { truncated: boolean; reason: string | null } }).summary };
    };
    const grep = (jobId: string) => client!.startGrepJob({ sessionId: "search-session", jobId, kind: "grep", cwd: workspace, path: ".", pattern: "beta" });
    await grep("grep-1");
    const first = await drain("grep-1"); expect(first.state).toBe("completed");
    const keys = (first.lines as Array<{ path: string; line: number }>).map((match) => [match.path, match.line]); expect(keys).toEqual([...keys].sort()); expect(first.summary.truncated).toBe(false);
    expect((first.lines as Array<{ path: string }>).some((match) => match.path === "src/main.ts")).toBe(true);
    // 确定性：同一查询重复执行结果完全一致
    await grep("grep-2"); expect((await drain("grep-2")).lines).toEqual(first.lines);
    await client.startGlobJob({ sessionId: "search-session", jobId: "glob-1", kind: "glob", cwd: workspace, path: ".", pattern: "*.ts" });
    const glob = await drain("glob-1"); expect((glob.lines as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["src/main.ts", "src/util.ts"]); expect(glob.summary.truncated).toBe(false);
    // 预算截断：maxNodes=1 必定截断且原因上报
    await client.startGlobJob({ sessionId: "search-session", jobId: "glob-budget", kind: "glob", cwd: workspace, path: ".", pattern: "*", maxNodes: 1 });
    expect((await drain("glob-budget")).summary).toMatchObject({ truncated: true, reason: "nodes" });
    // 取消语义：小工作区可能先跑完（Linux CI 出现过竞态），先铺足够多文件保证 cancel 到达时 job 仍在运行
    mkdirSync(path.join(workspace, "bulk"));
    for (let i = 0; i < 3000; i += 1) writeFileSync(path.join(workspace, "bulk", `f${i}.txt`), `beta line ${i}\n`);
    await client.startGrepJob({ sessionId: "search-session", jobId: "grep-cancel", kind: "grep", cwd: workspace, path: "bulk", pattern: "beta" });
    expect(await client.cancelJob({ sessionId: "search-session", jobId: "grep-cancel" })).toEqual({ jobId: "grep-cancel", accepted: true }); expect((await drainJob(client, "search-session", "grep-cancel", 64, 100)).state).toBe("cancelled");
  }, 30_000);
});

describe("CoreClient crash recovery", () => {
  it("崩溃后持续重试（退避封顶）而非 3 次后放弃；请求命中已死 core 时即时拉起重启", async () => {
    const recovery = new CoreClient(path.join(tmpdir(), `owc-missing-core-${process.pid}`), 5_000);
    recovery.on("error", () => { /* 重启失败以 error 事件上报，测试中吞掉 */ });
    const exits: CoreEvent[] = [];
    recovery.on("event", (event) => { if (event.type === "core.exit") exits.push(event); });
    await expect(recovery.start()).rejects.toThrow();
    // 旧逻辑 3 次退避后永久放弃（含首次共 4 次尝试）；新逻辑封顶退避持续重试
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(4), { timeout: 20_000 });
    const before = exits.length;
    await expect(recovery.ping()).rejects.toThrow("Core is not running");
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(before), { timeout: 10_000 });
    await recovery.stop();
  }, 30_000);
});

describe("FrameDecoder", () => {
  it("跨块与相邻帧（含多字节 UTF-8）正确切分", () => {
    const decoder = new FrameDecoder();
    const messages: unknown[] = [];
    decoder.on("message", (message) => messages.push(message));
    const first = encodeFrame({ text: "你好" });
    const input = Buffer.concat([first, encodeFrame({ value: 2 })]);
    decoder.push(input.subarray(0, 7));
    decoder.push(input.subarray(7, first.length + 3));
    decoder.push(input.subarray(first.length + 3)); expect(messages).toEqual([{ text: "你好" }, { value: 2 }]);
  });

  it("畸形 header 拒绝：重复 Content-Length、超长 header 行、超过 32 MiB 的声明", () => {
    const errorsOf = (raw: string): Error[] => {
      const decoder = new FrameDecoder();
      const errors: Error[] = [];
      decoder.on("error", (error) => errors.push(error));
      decoder.push(Buffer.from(raw));
      return errors;
    };
    expect(errorsOf("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}")[0]?.message).toContain("Duplicate"); expect(errorsOf(`X-Fill: ${"x".repeat(8192)}\r\nContent-Length: 2\r\n\r\n{}`)[0]?.message).toContain("header exceeds");
    // 合法的 32 MiB 声明先缓冲（不预分配合成载荷），超过即拒绝
    expect(errorsOf("Content-Length: 33554432\r\n\r\n")).toEqual([]); expect(errorsOf("Content-Length: 33554433\r\n\r\n")[0]?.message).toContain("32 MiB");
  });
});

function coreInfo(overrides: Partial<CoreInfo> = {}): CoreInfo {
  return {
    version: "0.2.4",
    protocolVersion: CORE_PROTOCOL_VERSION,
    platform: "windows",
    sandboxCapability: "enforced",
    features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: true, fsHash: true, fsScanPagination: true, fsWatch: true },
    limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
    ...overrides,
  };
}

describe("CoreGateway", () => {
  it("协商一次并缓存能力快照、失败不入缓存、invalidate 后重新协商；拒绝不兼容协议与残缺 records", async () => {
    let pings = 0;
    const gateway = new CoreGateway({ ping: async () => { pings += 1; return coreInfo({ features: { ...coreInfo().features!, jobControl: false } }); } });
    await expect(gateway.supports("jobControl")).resolves.toBe(false);
    await expect(gateway.supports("fsWatch")).resolves.toBe(true); expect(pings).toBe(1);
    gateway.invalidate();
    await gateway.info(); expect(pings).toBe(2);
    // 协商失败不入缓存：下一次调用重新 ping，成功后缓存
    let attempts = 0;
    const flaky = new CoreGateway({ ping: async () => { attempts += 1; if (attempts === 1) throw new Error("core not ready"); return coreInfo(); } });
    await expect(flaky.info()).rejects.toThrow("core not ready");
    await expect(flaky.info()).resolves.toMatchObject({ protocolVersion: CORE_PROTOCOL_VERSION });
    await flaky.info(); expect(attempts).toBe(2); expect(() => negotiate(coreInfo({ protocolVersion: "0.9" }))).toThrow(CoreProtocolError);
    expect(() => negotiate(coreInfo({ features: { ...coreInfo().features!, fsWatch: undefined as never } }))).toThrow("features.fsWatch");
    expect(() => negotiate(coreInfo({ limits: { ...coreInfo().limits!, maxConcurrentJobs: 0 } }))).toThrow("limits.maxConcurrentJobs");
  });

  it("接线的 core.ready 事件使协商缓存失效，能力判定重新 ping", async () => {
    const root = await tempRoot("owc-gw-ready-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
    let listener: ((event: CoreEvent) => void) | undefined;
    let pings = 0;
    const core = makeFakeCore({
      async ping() { pings += 1; return FAKE_CORE_INFO; },
      on(eventName: string, eventListener: (...args: unknown[]) => void) {
        if (eventName === "event") listener = eventListener as (event: CoreEvent) => void;
        return core;
      },
    });
    const agent = new AgentRunner(sessions, new ProviderRegistry(), core, new EventBus(), pricing);
    // runShell 首次用到 jobControl 能力：协商一次后缓存
    await agent.runShell(session.id, "echo one");
    await agent.runShell(session.id, "echo two"); expect(pings).toBe(1);
    // core 重启完成重新握手：快照失效，下次用到时重新协商
    listener?.({ source: "core", type: "core.ready", payload: FAKE_CORE_INFO });
    await agent.runShell(session.id, "echo three"); expect(pings).toBe(2);
  }, 15_000);
});

describe("CoreLogArchive", () => {
  it("initialize 建目录、append 落 core.log；超阈值轮转一代、未超不轮转；目录缺失时静默丢日志", async () => {
    const root = await tempRoot("owc-corelog-");
    const logDir = path.join(root, "logs");
    const archive = new CoreLogArchive(logDir, 16);
    await archive.initialize();
    archive.append("[owc-exec] first\n");
    archive.append("[owc-exec] second\n");
    await vi.waitFor(async () => expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("[owc-exec] first\n[owc-exec] second\n"));
    // 超阈值：core.log 轮转为 core.log.1（覆盖上一代），append 重建当前代
    await writeFile(path.join(logDir, "core.log"), "x".repeat(32), "utf8");
    await writeFile(path.join(logDir, "core.log.1"), "previous-generation", "utf8");
    await archive.initialize(); expect(await readFile(path.join(logDir, "core.log.1"), "utf8")).toBe("x".repeat(32));
    archive.append("fresh\n");
    await vi.waitFor(async () => expect(await readFile(path.join(logDir, "core.log"), "utf8")).toBe("fresh\n"));
    // 未超阈值：不轮转
    const quietDir = path.join(await tempRoot("owc-corelog-"), "logs");
    const quiet = new CoreLogArchive(quietDir, 1024);
    await quiet.initialize();
    await writeFile(path.join(quietDir, "core.log"), "small\n", "utf8");
    await quiet.initialize(); expect(await readFile(path.join(quietDir, "core.log"), "utf8")).toBe("small\n");
    await expect(stat(path.join(quietDir, "core.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
    // 未 initialize（目录不存在）：append 静默失败不抛错
    const orphan = new CoreLogArchive(path.join(root, "missing", "logs")); expect(() => orphan.append("dropped\n")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describeIfCore("CoreClient fs.readBase64 / writeFileBase64 (real core)", () => {
  it("二进制往返保真（NUL/0xFF/0x89PNG），缺失文件映射稳定错误码 -32003", async () => {
    const cwd = await tempRoot("owc-read-base64-");
    client = new CoreClient(corePath);
    const info = await client.start(); expect(info.features?.fsReadBase64).toBe(true); expect(info.limits?.maxReadBase64Bytes).toBe(20 * 1024 * 1024);
    await configureSession(client, "test-session", cwd);
    const blob = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0x00, 0xff, 0xfe, 0x00])]);
    await writeFile(path.join(cwd, "blob.bin"), blob);
    const read = await client.readFileBase64!({ sessionId: "test-session", path: "blob.bin" }); expect(read).toMatchObject({ truncated: false, size: blob.length }); expect(Buffer.from(read.base64, "base64")).toEqual(blob);
    const written = Buffer.from("pretend-png-bytes\x00\x89PNG", "binary");
    await client.writeFileBase64!({ sessionId: "test-session", path: "image.png", data: written.toString("base64") });
    expect(Buffer.from((await client.readFileBase64!({ sessionId: "test-session", path: "image.png" })).base64, "base64")).toEqual(written);
    const failure = await client.readFileBase64!({ sessionId: "test-session", path: "missing.bin" }).catch((error: unknown) => error); expect(failure).toBeInstanceOf(CoreRpcError);
    expect((failure as CoreRpcError).code).toBe(-32003); // 缺失文件映射稳定错误码
  });
});

describeIfCore("owc-exec CLI", () => {
  const listenLoopback = async (): Promise<number> => {
    server = createServer();
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind a port");
    return address.port;
  };
  const runToExit = async (args: string[]): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
    const proc = spawn(corePath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.once("exit", (code) => resolve({ code, stderr }));
  });
  itIfCore("--connect 回连 TCP loopback 完成握手，core.shutdown 后自行退出", async () => {
    const port = await listenLoopback();
    const socket = new Promise<Socket>((resolve) => server!.once("connection", resolve));
    child = spawn(corePath, ["--connect", `127.0.0.1:${port}`], { windowsHide: true });
    // 复用 CoreClient 的外部连接注入：传输为回连 socket，完成真实握手
    client = new CoreClient(corePath, 10_000, async () => ({ transport: new TcpTransport(await socket) }));
    const info = await client.start(); expect(["windows", "linux", "darwin"]).toContain(info.platform); expect(info.sandboxCapability).toBeTruthy();
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
  itIfCore("参数非法以 usage 退出码 2；连接失败以非零码退出", async () => {
    const invalid = await runToExit(["--bogus"]); expect(invalid.code).toBe(2); expect(invalid.stderr).toContain("usage:");
    // 空闲端口（已关闭监听）上的连接应立即失败
    const port = await listenLoopback();
    server.close();
    server = undefined; expect((await runToExit(["--connect", `127.0.0.1:${port}`])).code).toBe(1);
  }, 15_000);
});

describeIfCore("IndexManager against real core", () => {
  it("真实 index.scan + index.extract 后状态 fresh，可检索文件与符号", async () => {
    const workspace = await tempRoot("owc-index-e2e-ws-");
    const indexRoot = await tempRoot("owc-index-e2e-idx-");
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "util.ts"), "export function helperFn(): number {\n  return 1;\n}\n");
    writeFileSync(path.join(workspace, "src", "main.ts"), "export const betaValue = 2;\n");
    client = new CoreClient(corePath);
    const info = await client.start(); expect([info.features?.indexScan, info.features?.indexExtract]).toEqual([true, true]);
    await configureSession(client, "index-e2e", workspace);
    manager = new IndexManager(client, indexRoot, new EventBus(), { pollMs: 20, autoRefresh: false });
    await manager.rebuild("index-e2e", workspace);
    let status = await manager.status("index-e2e", workspace);
    for (let attempt = 0; status.status === "building" && attempt < 400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = await manager.status("index-e2e", workspace);
    }
    // base64 解码回归：修复前这里会因 JSONL 解析出 base64 垃圾而 error/stale
    expect(status).toMatchObject({ status: "fresh", files: 2 }); expect((await manager.searchSymbols(workspace, "helperFn")).some((hit) => hit.path === "src/util.ts" && hit.kind === "function")).toBe(true);
    expect((await manager.searchFiles(workspace, "main")).some((hit) => hit.path === "src/main.ts")).toBe(true);
  }, 30_000);
});
