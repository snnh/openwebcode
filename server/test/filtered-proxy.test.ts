import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreClientLike, JobStartRequest, JobStatus } from "../src/core-client.js";
import { CoreRouter } from "../src/sandbox/core-router.js";
import { FilteredProxyManager, type FilteredProxyDeps } from "../src/sandbox/filtered-proxy.js";
import type { ProxyConfig } from "../src/proxy.js";
import { SettingsService, SettingsValidationError } from "../src/settings-service.js";
import type { SandboxPolicy, SessionMeta } from "../src/sessions/types.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRootRetry } from "./helpers/temp-roots.js";

/**
 * filtered 网络档 sidecar 编排测试：
 * - 编排单测：fake-core 驱动 ensureProxy/releaseProxy/refreshDenyFiles 与 CoreRouter 两阶段下发；
 * - 代理脚本实测：本机直接 spawn node sandbox-proxy.mjs（不经沙盒），覆盖 CONNECT 隧道、
 *   明文转发、deny 命中/热生效、上游接力；
 * - 设置项 sandboxProxyDenyList 校验与热生效钩子。
 */

const children: ChildProcess[] = [];
const sockets: net.Socket[] = [];
const servers: http.Server[] = [];

// sidecar 子进程可能锁住临时目录：走 rmWithRetry 变体（afterEach 先杀进程再清理）
const makeTempRoot = (): Promise<string> => tempRootRetry("owc-filtered-proxy-");

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---- fake core（job 面） --------------------------------------------------------

interface JobCalls {
  startJob: JobStartRequest[];
  cancelJob: string[];
  configureSession: Array<{ sessionId: string; cwd: string; sandbox: SandboxPolicy }>;
}

function makeJobFakeCore(options?: { port?: number; silent?: boolean }) {
  const jobs = new Map<string, { status: JobStatus; output: string }>();
  const calls: JobCalls = { startJob: [], cancelJob: [], configureSession: [] };
  let startCount = 0;
  const client = makeFakeCore({
    async startJob(request: JobStartRequest) {
      calls.startJob.push(request);
      startCount += 1;
      const output = options?.silent ? "" : `OWC_PROXY_PORT ${(options?.port ?? 43210) + startCount - 1}\n`;
      jobs.set(request.jobId, { status: { jobId: request.jobId, state: "running" }, output });
      return { jobId: request.jobId, state: "running" } as JobStatus;
    },
    async jobStatus({ jobId }: { sessionId: string; jobId: string }) {
      return jobs.get(jobId)?.status ?? ({ jobId, state: "failed", error: "unknown job" } as JobStatus);
    },
    async jobOutput({ jobId, afterSeq }: { sessionId: string; jobId: string; afterSeq: number }) {
      const job = jobs.get(jobId);
      const data = afterSeq === 0 ? job?.output ?? "" : "";
      return { chunks: data ? [{ seq: 1, stream: "stdout" as const, data }] : [], nextSeq: data ? 2 : afterSeq, truncated: false };
    },
    async cancelJob({ jobId }: { sessionId: string; jobId: string }) {
      calls.cancelJob.push(jobId);
      const job = jobs.get(jobId);
      if (job) job.status = { jobId, state: "cancelled" };
      return { jobId, accepted: true as const };
    },
    async configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }) {
      calls.configureSession.push(request);
      return { sandboxCapability: "enforced" as const };
    },
  } as unknown as Partial<CoreClientLike>);
  return { client, calls, jobs };
}

function makeManager(dataDir: string, extra?: Partial<FilteredProxyDeps>): FilteredProxyManager {
  // runtime 投递需要真实源文件：在 dataDir 下造 node 与脚本的假源，缺省注入它们
  const srcNodeDir = path.join(dataDir, "src-node");
  const srcAssets = path.join(dataDir, "src-assets");
  mkdirSync(srcNodeDir, { recursive: true });
  mkdirSync(srcAssets, { recursive: true });
  const nodeExe = path.join(srcNodeDir, "node.exe");
  writeFileSync(nodeExe, "fake-node");
  writeFileSync(path.join(srcAssets, "sandbox-proxy.mjs"), "// fake\n");
  return new FilteredProxyManager({
    dataDir,
    getProxyConfig: () => ({ mode: "off" }),
    getDenyList: () => ["Denied.Example", " a.b.org "],
    platform: "win32",
    nodeExe,
    assetsDir: srcAssets,
    log: () => undefined,
    ...extra,
  });
}

/** 缺省 win32 平台的 runtime 投递目标（与 FilteredProxyManager 内部一致）。 */
function stagedPaths(root: string): { nodeExe: string; script: string } {
  return {
    nodeExe: path.join(root, "proxy", "runtime", "node.exe"),
    script: path.join(root, "proxy", "runtime", "sandbox-proxy.mjs"),
  };
}

describe("FilteredProxyManager 编排", () => {
  it("ensureProxy 起 job（network=allow）、写 deny 文件并解析端口", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore({ port: 43210 });
    const manager = makeManager(root);
    const handle = await manager.ensureProxy(client, "s1", "D:\\work");
    const staged = stagedPaths(root);
    expect(handle.proxyAddr).toBe("127.0.0.1:43210");
    expect(handle.readOnlyPaths).toEqual([path.join(root, "proxy")]);
    expect(existsSync(staged.nodeExe)).toBe(true);
    expect(existsSync(staged.script)).toBe(true);
    expect(calls.startJob).toHaveLength(1);
    const job = calls.startJob[0]!;
    expect(job.network).toBe("allow");
    expect(job.kind).toBe("exec");
    expect(job.cwd).toBe("D:\\work");
    expect(job.cmd).toContain("OWC_PROXY_DENY_FILE=");
    expect(job.cmd).toContain(`"${staged.nodeExe}" --preserve-symlinks-main "${staged.script}"`);
    expect(job.cmd).not.toContain("OWC_UPSTREAM_PROXY");
    const denyPath = path.join(root, "proxy", "s1.deny");
    expect(existsSync(denyPath)).toBe(true);
    const content = readFileSync(denyPath, "utf8");
    expect(content).toContain("denied.example");
    expect(content).toContain("a.b.org");
  });

  it("ensureProxy 幂等：sidecar 存活时不重起", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore();
    const manager = makeManager(root);
    const first = await manager.ensureProxy(client, "s1", "D:\\work");
    const second = await manager.ensureProxy(client, "s1", "D:\\work");
    expect(second).toEqual(first);
    expect(calls.startJob).toHaveLength(1);
  });

  it("sidecar 意外结束后下一次 ensureProxy 重起", async () => {
    const root = await makeTempRoot();
    const { client, calls, jobs } = makeJobFakeCore({ port: 50000 });
    const manager = makeManager(root);
    const first = await manager.ensureProxy(client, "s1", "D:\\work");
    const jobId = calls.startJob[0]!.jobId;
    jobs.get(jobId)!.status = { jobId, state: "failed", error: "crash" };
    const second = await manager.ensureProxy(client, "s1", "D:\\work");
    expect(calls.startJob).toHaveLength(2);
    expect(second.proxyAddr).toBe("127.0.0.1:50001");
    expect(second.proxyAddr).not.toBe(first.proxyAddr);
  });

  it("端口输出超时：cancel job 并报错", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore({ silent: true });
    const manager = makeManager(root, { portTimeoutMs: 300, pollMs: 10 });
    await expect(manager.ensureProxy(client, "s1", "D:\\work")).rejects.toThrow(/超时/);
    expect(calls.cancelJob).toEqual([`filtered-proxy-s1`]);
  });

  it("job 进入终态（failed）：直接报错", async () => {
    const root = await makeTempRoot();
    const { client, jobs, calls } = makeJobFakeCore({ silent: true });
    const manager = makeManager(root, { portTimeoutMs: 5_000, pollMs: 10 });
    const promise = manager.ensureProxy(client, "s1", "D:\\work");
    // ensureProxy 先异步写 deny 文件才 startJob；等 job 起来再翻终态
    await vi.waitFor(() => expect(calls.startJob).toHaveLength(1));
    jobs.get(`filtered-proxy-s1`)!.status = { jobId: "filtered-proxy-s1", state: "failed", error: "spawn ENOENT" };
    await expect(promise).rejects.toThrow(/spawn ENOENT/);
    expect(calls.startJob).toHaveLength(1);
  });

  it("releaseProxy 取消 job 并删除 deny 文件", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore();
    const manager = makeManager(root);
    await manager.ensureProxy(client, "s1", "D:\\work");
    const denyPath = path.join(root, "proxy", "s1.deny");
    expect(existsSync(denyPath)).toBe(true);
    await manager.releaseProxy(client, "s1");
    expect(calls.cancelJob).toEqual([`filtered-proxy-s1`]);
    expect(existsSync(denyPath)).toBe(false);
    // 未 ensure 过的会话 release 也是安全的 no-op
    await manager.releaseProxy(client, "s2");
  });

  it("refreshDenyFiles 重写活跃会话的 deny 文件", async () => {
    const root = await makeTempRoot();
    const { client } = makeJobFakeCore();
    let list = ["one.example"];
    const manager = makeManager(root, { getDenyList: () => list });
    await manager.ensureProxy(client, "s1", "D:\\work");
    const denyPath = path.join(root, "proxy", "s1.deny");
    expect(readFileSync(denyPath, "utf8")).toContain("one.example");
    list = ["two.example"];
    await manager.refreshDenyFiles();
    const content = readFileSync(denyPath, "utf8");
    expect(content).toContain("two.example");
    expect(content).not.toContain("one.example");
  });

  it("POSIX 命令行以 X=... 形式内嵌 env", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore();
    const manager = makeManager(root, { platform: "linux" });
    const handle = await manager.ensureProxy(client, "s1", "/work");
    // 路径一律为宿主语义（core 与 server 同机）；platform 只切换 cmd 的 env 语法
    expect(handle.readOnlyPaths).toEqual([path.join(root, "proxy")]);
    const cmd = calls.startJob[0]!.cmd;
    expect(cmd).toMatch(/^OWC_PROXY_DENY_FILE='[^']+' /);
    expect(cmd).toContain(`'${path.join(root, "proxy", "runtime", "node")}' --preserve-symlinks-main '${path.join(root, "proxy", "runtime", "sandbox-proxy.mjs")}'`);
  });
});

describe("FilteredProxyManager 上游折算", () => {
  const cases: Array<{ name: string; config: ProxyConfig; env?: NodeJS.ProcessEnv; expected: string }> = [
    { name: "off → 空", config: { mode: "off" }, env: { HTTPS_PROXY: "http://10.0.0.1:1" }, expected: "" },
    { name: "env → HTTPS_PROXY 优先", config: { mode: "env" }, env: { HTTPS_PROXY: "http://10.0.0.1:8888", HTTP_PROXY: "http://10.0.0.2:8888" }, expected: "http://10.0.0.1:8888/" },
    { name: "env → 小写回退", config: { mode: "env" }, env: { http_proxy: "http://10.0.0.3:7890" }, expected: "http://10.0.0.3:7890/" },
    { name: "env → 无变量为空", config: { mode: "env" }, env: {}, expected: "" },
    { name: "custom → https 优先回退 http", config: { mode: "custom", httpProxy: "http://10.0.0.4:7890", httpsProxy: "http://10.0.0.5:7890" }, expected: "http://10.0.0.5:7890/" },
    { name: "custom → 仅 http", config: { mode: "custom", httpProxy: "http://10.0.0.4:7890" }, expected: "http://10.0.0.4:7890/" },
  ];
  for (const item of cases) {
    it(item.name, async () => {
      const manager = makeManager(await makeTempRoot(), {
        getProxyConfig: () => item.config,
        env: item.env ?? {},
      });
      expect(manager.upstreamProxy()).toBe(item.expected);
    });
  }

  it("回环上游保留原值并警告平台边界一次", async () => {
    const warnings: string[] = [];
    const manager = makeManager(await makeTempRoot(), {
      getProxyConfig: () => ({ mode: "custom", httpProxy: "http://user:pass@127.0.0.1:7890" }),
      log: (line) => warnings.push(line),
    });
    expect(manager.upstreamProxy()).toBe("http://user:pass@127.0.0.1:7890/");
    expect(manager.upstreamProxy()).toBe("http://user:pass@127.0.0.1:7890/");
    expect(warnings.filter((line) => line.includes("LoopbackExempt"))).toHaveLength(1);
  });

  it("localhost 上游同样保留原值并警告", async () => {
    const warnings: string[] = [];
    const manager = makeManager(await makeTempRoot(), {
      getProxyConfig: () => ({ mode: "env" }),
      env: { HTTPS_PROXY: "http://localhost:7890" },
      log: (line) => warnings.push(line),
    });
    expect(manager.upstreamProxy()).toBe("http://localhost:7890/");
    expect(warnings).toHaveLength(1);
  });

  it("上游注入 cmd（Windows set 形式）", async () => {
    const root = await makeTempRoot();
    const { client, calls } = makeJobFakeCore();
    const manager = makeManager(root, {
      getProxyConfig: () => ({ mode: "custom", httpProxy: "http://10.0.0.9:7890" }),
    });
    await manager.ensureProxy(client, "s1", "D:\\work");
    expect(calls.startJob[0]!.cmd).toContain('set "OWC_UPSTREAM_PROXY=http://10.0.0.9:7890/"');
  });
});

// ---- CoreRouter 集成 ------------------------------------------------------------

function makeMeta(id: string, network: SandboxPolicy["network"]): SessionMeta {
  return {
    id,
    cwd: "D:\\work",
    provider: "test-stub",
    model: "deterministic-tool-loop",
    title: id,
    sandboxMode: "appcontainer",
    sandbox: { enabled: true, readRoots: ["D:\\work"], writeRoots: ["D:\\work"], denyPaths: [], network },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("CoreRouter filtered 两阶段下发", () => {
  async function makeRouter(meta: SessionMeta) {
    const { client, calls, jobs } = makeJobFakeCore({ port: 45678 });
    const sessions = { get: async (id: string) => (id === meta.id ? meta : undefined) };
    const wsb = {
      acquire: vi.fn(), peek: vi.fn(() => undefined), release: vi.fn(async () => undefined), releaseAll: vi.fn(async () => undefined),
      onClientCreated: undefined as undefined | ((sessionId: string, client: CoreClientLike) => void),
    };
    const root = await makeTempRoot();
    const manager = makeManager(root);
    const router = new CoreRouter(client, sessions, wsb as never, undefined, undefined, "win32", manager);
    return { router, client, calls, jobs, manager, root };
  }

  it("configure 补发 proxyAddr + readOnlyPaths", async () => {
    const { router, calls, root } = await makeRouter(makeMeta("s1", "filtered"));
    await router.run({ sessionId: "s1", execId: "e1", cmd: "echo hi", cwd: "D:\\work" });
    expect(calls.configureSession).toHaveLength(2);
    const [base, enriched] = calls.configureSession;
    expect(base!.sandbox.network).toBe("filtered");
    expect(base!.sandbox.proxyAddr).toBeUndefined();
    expect(enriched!.sandbox.proxyAddr).toBe("127.0.0.1:45678");
    expect(enriched!.sandbox.readOnlyPaths).toEqual([path.join(root, "proxy")]);
    expect(enriched!.sandbox.mode).toBe("appcontainer");
  });

  it("release 回收 sidecar", async () => {
    const { router, calls } = await makeRouter(makeMeta("s1", "filtered"));
    await router.run({ sessionId: "s1", execId: "e1", cmd: "echo hi", cwd: "D:\\work" });
    await router.release("s1");
    expect(calls.cancelJob).toContain("filtered-proxy-s1");
  });

  it("非 filtered 会话不触发 sidecar", async () => {
    const { router, calls } = await makeRouter(makeMeta("s1", "allow"));
    await router.run({ sessionId: "s1", execId: "e1", cmd: "echo hi", cwd: "D:\\work" });
    expect(calls.startJob).toHaveLength(0);
    expect(calls.configureSession).toHaveLength(1);
  });
});

// ---- 代理脚本实测（本机 spawn，不经沙盒） -----------------------------------------

const SCRIPT = fileURLToPath(new URL("../assets/sandbox-proxy.mjs", import.meta.url));

interface RunningProxy { proc: ChildProcess; port: number; stderr: () => string }

async function startScriptProxy(env: Record<string, string>): Promise<RunningProxy> {
  const proc = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sidecar 未输出端口行，stderr：${stderr}`)), 10_000);
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`sidecar 提前退出（${code}）：${stderr}`)); });
    proc.stdout!.on("data", () => {
      const match = /OWC_PROXY_PORT (\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  return { proc, port, stderr: () => stderr };
}

function listenTarget(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

/** 经代理发 CONNECT；200 时可选写入隧道数据并收集到连接关闭。 */
function connectTunnel(proxyPort: number, target: string, afterTunnel?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let tunneled = false;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
    socket.setTimeout(10_000, () => fail(new Error("tunnel timeout")));
    socket.once("error", (error) => fail(error));
    socket.on("data", (chunk) => {
      if (!tunneled) {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head)?.[1] ?? 0);
        if (status !== 200) {
          settled = true;
          socket.destroy();
          resolve({ status, body: "" });
          return;
        }
        tunneled = true;
        body = buffer.subarray(end + 4);
        if (afterTunnel) socket.write(afterTunnel);
        return;
      }
      body = Buffer.concat([body, chunk]);
    });
    socket.on("close", () => {
      if (!settled && tunneled) { settled = true; resolve({ status: 200, body: body.toString("utf8") }); }
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

/** 经代理发明文 HTTP 请求（absolute-form）。 */
function plainGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { connection: "close" } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("sandbox-proxy.mjs 实测", () => {
  it("CONNECT 隧道到本地目标往返成功", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "# empty\n", "utf8");
    const targetPort = await listenTarget((req, res) => res.end(`hello:${req.url ?? ""}`));
    const proxy = await startScriptProxy({ OWC_PROXY_DENY_FILE: denyPath });
    const result = await connectTunnel(proxy.port, `127.0.0.1:${targetPort}`, "GET /tunneled?q=1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(result.status).toBe(200);
    expect(result.body).toContain("hello:/tunneled?q=1");
  });

  it("明文 HTTP 转发", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "", "utf8");
    const targetPort = await listenTarget((req, res) => res.end(`plain:${req.url ?? ""}`));
    const proxy = await startScriptProxy({ OWC_PROXY_DENY_FILE: denyPath });
    const result = await plainGet(proxy.port, `http://127.0.0.1:${targetPort}/a/b?x=1`);
    expect(result.status).toBe(200);
    expect(result.body).toBe("plain:/a/b?x=1");
  });

  it("deny 命中 → 403 并记日志；后缀匹配子域名", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "# comment\n\nexample.com\n", "utf8");
    const proxy = await startScriptProxy({ OWC_PROXY_DENY_FILE: denyPath });
    const deniedRoot = await connectTunnel(proxy.port, "example.com:443");
    expect(deniedRoot.status).toBe(403);
    const deniedSub = await connectTunnel(proxy.port, "a.example.com:443");
    expect(deniedSub.status).toBe(403);
    expect(proxy.stderr()).toContain("[deny] example.com");
    expect(proxy.stderr()).toContain("[deny] a.example.com");
    const deniedPlain = await plainGet(proxy.port, "http://www.example.com/");
    expect(deniedPlain.status).toBe(403);
  });

  it("deny 文件修改后热生效", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "# empty\n", "utf8");
    const proxy = await startScriptProxy({ OWC_PROXY_DENY_FILE: denyPath });
    // 未拦截时：目标域名不可达 → 502（NXDOMAIN 快速失败）
    const before = await connectTunnel(proxy.port, "missing.example.com:443");
    expect(before.status).toBe(502);
    writeFileSync(denyPath, "missing.example.com\n", "utf8");
    await vi.waitFor(async () => {
      const after = await connectTunnel(proxy.port, "missing.example.com:443");
      expect(after.status).toBe(403);
    }, { timeout: 5_000, interval: 100 });
  });

  it("目标不可达 → 502", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "", "utf8");
    const proxy = await startScriptProxy({ OWC_PROXY_DENY_FILE: denyPath });
    // 保留一个几乎不可能监听的端口（先 listen 再 close 取得空闲端口）
    const targetPort = await listenTarget(() => undefined);
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const result = await connectTunnel(proxy.port, `127.0.0.1:${targetPort}`);
    expect(result.status).toBe(502);
  });

  it("上游接力：CONNECT 经上游（含 Proxy-Authorization），明文也走上游", async () => {
    const root = await makeTempRoot();
    const denyPath = path.join(root, "test.deny");
    writeFileSync(denyPath, "", "utf8");
    const targetPort = await listenTarget((req, res) => res.end(`via-target:${req.url ?? ""}`));
    const seen: Array<{ kind: string; url: string; auth: string | undefined; path?: string }> = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ kind: "request", url: req.url ?? "", auth: req.headers["proxy-authorization"], ...(req.url ? { path: req.url } : {}) });
      res.end("via-upstream");
    });
    servers.push(upstream);
    upstream.on("connect", (req, socket, head) => {
      seen.push({ kind: "connect", url: req.url ?? "", auth: req.headers["proxy-authorization"] });
      const [host, portText] = (req.url ?? "").split(":");
      const target = net.connect({ host: host ?? "127.0.0.1", port: Number(portText) });
      target.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) target.write(head);
        socket.pipe(target).pipe(socket);
      });
      target.once("error", () => socket.destroy());
      socket.once("error", () => target.destroy());
    });
    const upstreamPort = await new Promise<number>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => {
        const address = upstream.address();
        if (!address || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
    const proxy = await startScriptProxy({
      OWC_PROXY_DENY_FILE: denyPath,
      OWC_UPSTREAM_PROXY: `http://user:pass@127.0.0.1:${upstreamPort}`,
    });
    // CONNECT 经上游接力，隧道内数据真实往返目标
    const tunneled = await connectTunnel(proxy.port, `127.0.0.1:${targetPort}`, "GET /relay HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(tunneled.status).toBe(200);
    expect(tunneled.body).toContain("via-target:/relay");
    const connectSeen = seen.find((entry) => entry.kind === "connect");
    expect(connectSeen?.url).toBe(`127.0.0.1:${targetPort}`);
    expect(connectSeen?.auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    // 明文请求也走上游（absolute-form + 凭据）
    const plain = await plainGet(proxy.port, `http://127.0.0.1:${targetPort}/plain`);
    expect(plain.status).toBe(200);
    expect(plain.body).toBe("via-upstream");
    const requestSeen = seen.find((entry) => entry.kind === "request");
    expect(requestSeen?.url).toBe(`http://127.0.0.1:${targetPort}/plain`);
    expect(requestSeen?.auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });
});

// ---- 设置项 sandboxProxyDenyList --------------------------------------------------

describe("设置项 sandboxProxyDenyList", () => {
  async function loadSettings(root: string, env: NodeJS.ProcessEnv = {}): Promise<SettingsService> {
    return SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
  }

  it("合法清单：去空白小写化合成进 config", async () => {
    const service = await loadSettings(await makeTempRoot());
    await service.update({ sandboxProxyDenyList: ["Example.COM ", " sub.a.org"] });
    expect(service.effective().sandboxProxyDenyList).toEqual(["example.com", "sub.a.org"]);
  });

  it("非法条目被拒绝", async () => {
    const service = await loadSettings(await makeTempRoot());
    await expect(service.update({ sandboxProxyDenyList: ["bad domain!"] })).rejects.toThrow(SettingsValidationError);
    await expect(service.update({ sandboxProxyDenyList: [""] })).rejects.toThrow(SettingsValidationError);
    await expect(service.update({ sandboxProxyDenyList: ["ok.example", "also bad.."] })).rejects.toThrow(SettingsValidationError);
    await expect(service.update({ sandboxProxyDenyList: "not-an-array" })).rejects.toThrow(SettingsValidationError);
  });

  it("env 来源：逗号分隔且界面不可改", async () => {
    const service = await loadSettings(await makeTempRoot(), { OWC_SANDBOX_PROXY_DENY_LIST: "A.example, b.example" });
    expect(service.effective().sandboxProxyDenyList).toEqual(["a.example", "b.example"]);
    await expect(service.update({ sandboxProxyDenyList: ["c.example"] })).rejects.toThrow(/环境变量/);
  });

  it("保存触发 refreshDenyFiles 热生效钩子", async () => {
    const service = await loadSettings(await makeTempRoot());
    const refreshDenyFiles = vi.fn(async () => undefined);
    service.bind({
      providers: {} as never,
      core: {} as never,
      agent: {} as never,
      events: { publish: vi.fn() } as never,
      sandboxProxy: { refreshDenyFiles },
    });
    await service.update({ sandboxProxyDenyList: ["x.example"] });
    expect(refreshDenyFiles).toHaveBeenCalledTimes(1);
    // 无变化保存不重复触发
    await service.update({ sandboxProxyDenyList: ["x.example"] });
    expect(refreshDenyFiles).toHaveBeenCalledTimes(1);
  });

  it("默认空清单不进 ServerConfig", async () => {
    const service = await loadSettings(await makeTempRoot());
    expect(service.effective().sandboxProxyDenyList).toBeUndefined();
  });
});
