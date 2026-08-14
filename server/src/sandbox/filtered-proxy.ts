import { existsSync } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeUtf8Atomically } from "../atomic-file.js";
import type { CoreClientLike } from "../core-client.js";
import { ensureDirWithMode } from "../fs-utils.js";
import type { ProxyConfig } from "../proxy.js";

/**
 * filtered 网络档（Windows AppContainer）的 sidecar 代理编排。
 *
 * filtered 会话的业务沙盒进程不授 internetClient，HTTP_PROXY 指向同 AppContainer
 * 包内的 sidecar 代理进程（同包 loopback 互通）；sidecar 以 network=allow 覆盖
 * 经 core job.start 启动，持有出网能力。本模块负责其生命周期：
 * ensureProxy（幂等/断线重起）→ 解析端口 → releaseProxy（cancel job + 删 deny 文件）。
 *
 * deny 清单文件 <dataDir>/proxy/<sessionId>.deny 由 sidecar 脚本按 mtime 热重读；
 * 设置项 sandboxProxyDenyList 变更时经 refreshDenyFiles 重写所有活跃会话的清单。
 *
 * 运行时投递：AppContainer 默认读不了 Program Files 等系统目录（其 DACL 无
 * ALL APPLICATION PACKAGES，普通用户又无权改），因此 node 与 sidecar 脚本先复制到
 * <dataDir>/proxy/runtime/（用户拥有、可授 ACL），readOnlyPaths 只授 <dataDir>/proxy
 * 目录——运行时与 deny 文件（含原子替换后的新文件）都经目录继承 ACE 覆盖。
 */

/** 等待 sidecar 打印 OWC_PROXY_PORT 的超时（超时 cancel job 并报错）。 */
const DEFAULT_PORT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface FilteredProxyDeps {
  /** 业务数据目录；deny 文件写入 <dataDir>/proxy/。 */
  dataDir: string;
  /** 出站代理设置现读（settings.effective().proxy），折算 sidecar 的 OWC_UPSTREAM_PROXY。 */
  getProxyConfig: () => ProxyConfig;
  /** 拦截域名清单现读（settings.effective().sandboxProxyDenyList ?? []）。 */
  getDenyList: () => string[];
  /** 测试可注入固定平台；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** env 模式上游读取的环境；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 测试注入；缺省 release 布局 bundled node（<installRoot>/node/...）存在即用，否则 process.execPath。 */
  nodeExe?: string;
  /** 测试注入；缺省 server/assets（src 与 dist 布局一致解析）。 */
  assetsDir?: string;
  /** 测试注入；缺省 moduleDirectory 上溯三层（dist 下为 OWC_HOME）。 */
  installRoot?: string;
  /** 测试注入更短的超时/轮询间隔。 */
  portTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 日志行输出；缺省 stderr。 */
  log?: (line: string) => void;
}

interface FilteredProxyHandle {
  proxyAddr: string;
  readOnlyPaths: string[];
}

interface ActiveProxy {
  jobId: string;
  proxyAddr: string;
  denyPath: string;
}

/** 域名清单条目归一化：去空白、小写（sidecar 与设置校验共用同一语义）。 */
function normalizeDenyEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h.startsWith("127.");
}

/** POSIX sh 单引号转义。 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class FilteredProxyManager {
  private readonly active = new Map<string, ActiveProxy>();
  private readonly pending = new Map<string, Promise<FilteredProxyHandle>>();
  private warnedLoopbackUpstream = false;

  constructor(private readonly deps: FilteredProxyDeps) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private get log(): (line: string) => void {
    return this.deps.log ?? ((line) => process.stderr.write(`[filtered-proxy] ${line}\n`));
  }

  /** 目标平台仅决定行为分支（cmd 环境变量语法、node 文件名）；文件路径一律用宿主
   * path——core 是与 server 同机的子进程，投递/授权路径都落在宿主文件系统上，
   * 测试在异平台注入 platform 时宿主路径语义不变。 */
  private get assetsDir(): string {
    return this.deps.assetsDir ?? path.resolve(moduleDirectory, "..", "..", "assets");
  }

  private scriptPath(): string {
    return path.join(this.assetsDir, "sandbox-proxy.mjs");
  }

  /** sidecar 的 node：release 布局 bundled node 优先，开发环境回落 process.execPath。 */
  resolveNodeExe(): string {
    if (this.deps.nodeExe) return this.deps.nodeExe;
    const installRoot = this.deps.installRoot ?? path.resolve(moduleDirectory, "..", "..", "..");
    const bundled = this.platform === "win32"
      ? path.join(installRoot, "node", "node.exe")
      : path.join(installRoot, "node", "bin", "node");
    return existsSync(bundled) ? bundled : process.execPath;
  }

  /**
   * 随 session.configure 下发的只读授予：<dataDir>/proxy 目录。目录级继承 ACE 同时覆盖
   * runtime/（node 与脚本的投递副本）与之后原子替换的 deny 文件；AppContainer 直接授
   * Program Files 下的 node 路径会失败（普通用户无权改其 DACL），故不授源路径。
   */
  readOnlyPaths(): string[] {
    return [path.join(this.deps.dataDir, "proxy")];
  }

  private runtimeDir(): string {
    return path.join(this.deps.dataDir, "proxy", "runtime");
  }

  /**
   * 把 node 与 sidecar 脚本复制到 <dataDir>/proxy/runtime/（源 size/mtime 变化才重拷），
   * 返回供 sidecar 命令行使用的宿主路径（core 与 server 同机）。必须用真实副本而非硬链接：硬链接共享
   * 源文件的 DACL（Program Files 下不可授权），副本才是用户拥有、可授 ACL 的对象。
   */
  private async ensureRuntime(): Promise<{ nodeExe: string; script: string }> {
    const runtimeDir = this.runtimeDir();
    await ensureDirWithMode(runtimeDir, 0o700);
    const nodeName = this.platform === "win32" ? "node.exe" : "node";
    await this.stageFile(this.resolveNodeExe(), path.join(runtimeDir, nodeName));
    await this.stageFile(this.scriptPath(), path.join(runtimeDir, "sandbox-proxy.mjs"));
    return {
      nodeExe: path.join(this.deps.dataDir, "proxy", "runtime", nodeName),
      script: path.join(this.deps.dataDir, "proxy", "runtime", "sandbox-proxy.mjs"),
    };
  }

  private async stageFile(source: string, target: string): Promise<void> {
    const src = await stat(source);
    const dst = await stat(target).catch(() => undefined);
    if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) return;
    const tmp = `${target}.tmp-${process.pid}`;
    await copyFile(source, tmp);
    await rename(tmp, target);
  }

  private denyPathFor(sessionId: string): string {
    return path.join(this.deps.dataDir, "proxy", `${sessionId}.deny`);
  }

  private denyFileContent(): string {
    const entries = this.deps.getDenyList().map(normalizeDenyEntry).filter(Boolean);
    return `# openwebcode filtered 代理拦截清单（每行一个域名后缀，# 为注释）\n${entries.join("\n")}${entries.length > 0 ? "\n" : ""}`;
  }

  private async writeDenyFile(denyPath: string): Promise<void> {
    await ensureDirWithMode(path.dirname(denyPath), 0o700);
    await writeUtf8Atomically(denyPath, this.denyFileContent(), { mode: 0o600 });
  }

  /**
   * 出站代理设置 → sidecar 的 OWC_UPSTREAM_PROXY：off → 空；env → 读
   * HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy；custom → 设置值（https 优先回退 http）。
   * 上游位于本机回环（127.0.0.1/localhost）时如实警告：AppContainer 网络隔离禁止沙盒内
   * sidecar 连接宿主机服务——loopback 与本机 LAN IP 的 hairpin 同样被拦（实测），只有
   * 管理员 CheckNetIsolation LoopbackExempt 能解除；URL 原样下发（快速失败优于超时）。
   */
  upstreamProxy(): string {
    const config = this.deps.getProxyConfig();
    let raw = "";
    if (config.mode === "env") {
      const env = this.deps.env ?? process.env;
      raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? "";
    } else if (config.mode === "custom") {
      raw = config.httpsProxy ?? config.httpProxy ?? "";
    }
    if (!raw) return "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.log(`上游代理不是合法 URL，sidecar 按直连处理：${raw.replace(/\/\/.*@/, "//•••@")}`);
      return "";
    }
    if (isLoopbackHostname(url.hostname) && !this.warnedLoopbackUpstream) {
      this.warnedLoopbackUpstream = true;
      this.log("上游代理位于本机回环地址：AppContainer 隔离禁止沙盒内 sidecar 连接宿主机服务（本机 LAN IP 的 hairpin 同样被拦），该上游不可达——请改用直连、位于其他设备的代理，或由管理员配置 LoopbackExempt");
    }
    return url.toString();
  }

  /**
   * sidecar 启动命令。job.start 无 env 参数，环境变量嵌进 cmd 行：
   * Windows cmd 用 `set "X=..."&& ...`，POSIX sh 用 `X=... ...`（core default 后端即 cmd/sh）。
   */
  buildCommand(denyPath: string, runtime: { nodeExe: string; script: string }): string {
    const upstream = this.upstreamProxy();
    // --preserve-symlinks-main：node 解析脚本 realpath 时会逐组件 lstat 到盘符根（C:\），
    // 而 AppContainer 进程对盘符根无权限（非管理员 core 改不了其 DACL，祖先 traverse 授予
    // 只能 best-effort）。跳过 main 的 realpath 后脚本自身经 readOnlyPaths 授予可读。
    if (this.platform === "win32") {
      const parts = [`set "OWC_PROXY_DENY_FILE=${denyPath}"`];
      if (upstream) parts.push(`set "OWC_UPSTREAM_PROXY=${upstream}"`);
      return `${parts.join("&& ")}&& "${runtime.nodeExe}" --preserve-symlinks-main "${runtime.script}"`;
    }
    const parts = [`OWC_PROXY_DENY_FILE=${shQuote(denyPath)}`];
    if (upstream) parts.push(`OWC_UPSTREAM_PROXY=${shQuote(upstream)}`);
    return `${parts.join(" ")} ${shQuote(runtime.nodeExe)} --preserve-symlinks-main ${shQuote(runtime.script)}`;
  }

  /**
   * 幂等确保会话的 sidecar 代理在跑：已有活 job 直接返回；job 不再运行（断线/崩溃）
   * 则重起。返回 proxyAddr（127.0.0.1:<port>）与应并入 session.configure 的 readOnlyPaths。
   */
  async ensureProxy(client: CoreClientLike, sessionId: string, cwd: string): Promise<FilteredProxyHandle> {
    const existing = this.active.get(sessionId);
    if (existing) {
      const status = await client.jobStatus({ sessionId, jobId: existing.jobId }).catch(() => undefined);
      if (status?.state === "running") return { proxyAddr: existing.proxyAddr, readOnlyPaths: this.readOnlyPaths() };
      // sidecar 意外结束（或 core 重启后状态丢失）：清除记录，走重起路径
      this.active.delete(sessionId);
    }
    const pending = this.pending.get(sessionId);
    if (pending) return pending;
    const promise = this.startProxy(client, sessionId, cwd);
    this.pending.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(sessionId) === promise) this.pending.delete(sessionId);
    }
  }

  private async startProxy(client: CoreClientLike, sessionId: string, cwd: string): Promise<FilteredProxyHandle> {
    const denyPath = this.denyPathFor(sessionId);
    await this.writeDenyFile(denyPath);
    const runtime = await this.ensureRuntime();
    const jobId = `filtered-proxy-${sessionId}`;
    const cmd = this.buildCommand(denyPath, runtime);
    await client.startJob({ sessionId, jobId, kind: "exec", cmd, cwd, network: "allow" });
    const timeoutMs = this.deps.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS;
    const pollMs = this.deps.pollMs ?? DEFAULT_POLL_MS;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;
    let seq = 0;
    let stdout = "";
    for (;;) {
      const output = await client.jobOutput({ sessionId, jobId, afterSeq: seq });
      seq = output.nextSeq;
      for (const chunk of output.chunks) {
        if (chunk.stream === "stdout") stdout += chunk.data;
      }
      const match = /OWC_PROXY_PORT (\d+)/.exec(stdout);
      if (match) {
        const proxyAddr = `127.0.0.1:${match[1]}`;
        this.active.set(sessionId, { jobId, proxyAddr, denyPath });
        this.log(`session ${sessionId} sidecar 代理就绪：${proxyAddr}`);
        return { proxyAddr, readOnlyPaths: this.readOnlyPaths() };
      }
      const status = await client.jobStatus({ sessionId, jobId }).catch(() => undefined);
      if (status && status.state !== "running") {
        throw new Error(`filtered 代理 sidecar 启动失败（job ${status.state}）${status.error ? `：${status.error}` : ""}`);
      }
      if (Date.now() >= deadline) {
        await client.cancelJob({ sessionId, jobId }).catch(() => undefined);
        throw new Error(`filtered 代理 sidecar 启动超时（${timeoutMs}ms 内未输出 OWC_PROXY_PORT）`);
      }
      await sleep(pollMs);
    }
  }

  /** 释放会话 sidecar：cancel job（含启动中的确定性 jobId）+ 删 deny 文件，全部 best effort。 */
  async releaseProxy(client: CoreClientLike, sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId);
    this.active.delete(sessionId);
    await client.cancelJob({ sessionId, jobId: entry?.jobId ?? `filtered-proxy-${sessionId}` }).catch(() => undefined);
    await rm(this.denyPathFor(sessionId), { force: true }).catch(() => undefined);
  }

  /** 设置变更热生效：按当前清单重写所有活跃会话的 deny 文件（sidecar 按 mtime 自重读）。 */
  async refreshDenyFiles(): Promise<void> {
    await Promise.all([...this.active.values()].map((entry) => this.writeDenyFile(entry.denyPath).catch((error: unknown) => {
      this.log(`deny 清单热更新失败（${entry.denyPath}）：${error instanceof Error ? error.message : String(error)}`);
    })));
  }

  /** 活跃 sidecar 数（测试与诊断用）。 */
  activeCount(): number {
    return this.active.size;
  }
}
