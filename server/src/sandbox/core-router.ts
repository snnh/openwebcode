import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CoreClientLike,
  CoreInfo,
  ExecRequest,
  ExecResult,
  FsEditRequest,
  FsGlobResult,
  FsGrepResult,
  FsListResult,
  FsPathRequest,
  FsReadBase64Result,
  FsReadRequest,
  FsReadResult,
  FsSearchRequest,
  FsScanRequest,
  FsScanResult,
  FsWatchPollRequest,
  FsWatchPollResult,
  FsWatchRequest,
  JobOutputRequest,
  JobOutputResult,
  JobStartRequest,
  JobStatus,
  IndexScanStartRequest,
  GrepJobStartRequest,
  GlobJobStartRequest,
  IndexExtractStartRequest,
  SearchJobRequest,
  FsHashResult,
  FsStatResult,
  FsStatManyRequest,
  FsStatManyResult,
  FsWriteBase64Request,
  FsWriteRequest,
  PathNormalizeRequest,
  PathNormalizeResult,
  PtyInputRequest,
  PtyOpenRequest,
  PtyOpenResult,
  PtyResizeRequest,
  OverlayMountRequest,
  OverlayMountResult,
  OverlayCheckpointRequest,
  OverlayCopyResult,
  OverlayRestoreRequest,
  OverlayRestoreResult,
  OverlayUnmountRequest,
} from "../core-client.js";
import type { SessionStore } from "../sessions/session-store.js";
import { defaultSandboxPolicy } from "../sessions/default-sandbox.js";
import type { JobObjectLimits, NodeEnv, PythonEnv, SandboxPolicy, SessionMeta } from "../sessions/types.js";
import { effectiveNodeEnv, nodeToolchainReadOnlyPaths, nodeToolchainWritePaths, type NodeToolchainMountDeps } from "../node-env.js";
import { effectivePythonEnv, pythonEnvWritePaths } from "../python-env.js";
import type { FilteredProxyManager } from "./filtered-proxy.js";
import { WSB_WORKSPACE_MOUNT, type WsbManager } from "./wsb.js";

/**
 * 宿主路径 → WSB 沙盒内路径：仅翻译会话工作目录前缀（沙盒只能看到挂载点内的树），
 * 目录外路径原样透传——沙盒本就无法访问，由沙盒内 core 按现有策略拒绝。
 * exec.run 的 cmd 字符串内嵌路径不做翻译（不可可靠解析），调用方应使用相对路径。
 */
export function toSandboxPath(hostPath: string, workspace: string): string {
  const target = hostPath.replace(/\//g, "\\");
  const root = workspace.replace(/\//g, "\\");
  const lower = target.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower === rootLower) return WSB_WORKSPACE_MOUNT;
  if (lower.startsWith(`${rootLower}\\`)) return WSB_WORKSPACE_MOUNT + target.slice(root.length);
  return hostPath;
}

/**
 * Git/GitHub 凭据只读放行（POSIX）：bwrap/Landlock 沙盒只挂载会话工作区，宿主 $HOME
 * 不可见，沙盒内 git push / gh 因取不到凭据而挂起交互提示（表现为命令卡死）。
 * 把标准凭据路径并入 readOnlyPaths：沙盒内进程只读可见；fs.* 工具的路径策略不含
 * readOnlyPaths，工具层读不到凭据内容。Windows Job Object 无文件系统隔离（凭据本就可读），
 * 不追加。core 侧 readOnlyPaths 上限 16：用户配置优先，凭据按序补到满为止（尽力而为）。
 */
export function gitCredentialReadOnlyPaths(existing: string[] | undefined, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string[] {
  const merged = [...(existing ?? [])];
  if (platform === "win32" || !home) return merged;
  const candidates = [".gitconfig", ".git-credentials", ".config/git", ".config/gh", ".ssh"]
    .map((rel) => path.join(home, rel))
    .filter((candidate) => existsSync(candidate));
  for (const candidate of candidates) {
    if (merged.length >= 16) break;
    if (!merged.includes(candidate)) merged.push(candidate);
  }
  return merged;
}

/**
 * 与 nodeEnv 选择绑定的 Node 工具链只读放行（POSIX）：沙盒只挂载会话工作区与系统树，
 * 用户的 node/npm 若是 nvm/fnm 安装而 nodeEnv=global，沙盒内 PATH 继承了但目录
 * 不可见（表现为 npm: command not found）。按生效 nodeEnv 把对应工具链目录并入
 * readOnlyPaths（global 解析宿主 PATH 上生效的工具链根），目录语义见
 * node-env.nodeToolchainReadOnlyPaths。core 侧 readOnlyPaths 上限 16：用户配置与凭据之后补齐。
 */
export function nodeEnvReadOnlyPaths(existing: string[] | undefined, mode: NodeEnv, platform: NodeJS.Platform = process.platform, deps: NodeToolchainMountDeps = {}): string[] {
  const merged = [...(existing ?? [])];
  for (const dir of nodeToolchainReadOnlyPaths(mode, { ...deps, platform })) {
    if (merged.length >= 16) break;
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged;
}

/**
 * 非本机环境的工具链读写放行（POSIX；bwrap rw-bind / Landlock 完整访问集，经 allowPaths
 * 下发）：显式选择 fnm/nvm（nodeEnv）或 uv-config（pythonEnv）时，把版本管理器目录 / venv
 * 目录并入读写层，读写与安装权限严格限定在环境自身目录（npm i -g、pip install 落在目录内；
 * 系统树只读、HOME 不挂载，整机全局安装不可能）。global/project/uv-workspace 不追加
 * （global node 走只读层；project 与 uv-workspace 在工作区内随 writeRoots 可写）。
 * core 侧 allowPaths 上限 16：用户配置优先，工具链目录按序补到满（尽力而为）。
 */
export function toolchainWritePaths(existing: string[] | undefined, dirs: readonly string[]): string[] {
  const merged = [...(existing ?? [])];
  for (const dir of dirs) {
    if (merged.length >= 16) break;
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged;
}

/** wsb 会话的请求路径翻译；其余会话原样返回。host 绝对路径或带点分量的路径
 * 先经宿主机 core 的 path.normalize 归一化（路径处理归一在 core C 层完成），
 * 再做 host→guest 挂载映射；normalize 失败回退原始字符串。 */
function needsHostNormalize(path: string): boolean {
  return path.includes("..") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

/**
 * 按会话路由 core 调用：sandboxMode=="wsb" 的会话走 WsbManager 懒启动的沙盒内 core，
 * 其余会话共享宿主机 CoreClient。只实现 agent-runner/app/settings 实际用到的方法子集，
 * 与 CoreClient 同构（CoreClientLike）。
 */
export class CoreRouter extends EventEmitter {
  /** 全局 Job Object 资源限制覆盖（仅 Windows）；缺省不下发，core 用内置默认值。 */
  private readonly jobObject: JobObjectLimits | undefined;
  /** AppContainer 额外可写目录；WSB 会话不映射宿主机目录。 */
  private readonly allowPaths: string[] | undefined;
  /** 缺省沙盒模式的平台判定（policyFor 分流）；测试可注入固定平台。 */
  private readonly platform: NodeJS.Platform;
  /** 全局默认 nodeEnv（settings 热生效现读）：与 nodeEnv 绑定的工具链挂载按生效值计算。 */
  private nodeEnvDefault?: () => NodeEnv | undefined;
  /** 全局默认 pythonEnv（同上）；数据目录用于 uv-config 的 venv 挂载目录计算。 */
  private pythonEnvDefault?: () => PythonEnv | undefined;
  private dataDir: string | undefined;

  /** 注入全局默认 nodeEnv 解析器（与 AgentRunner.setNodeEnvDefault 同源）。 */
  setNodeEnvDefault(getter: () => NodeEnv | undefined): void {
    this.nodeEnvDefault = getter;
  }

  /** 注入全局默认 pythonEnv 解析器与数据目录（与 AgentRunner.setPythonEnvDefault 同源）。 */
  setPythonEnvDefault(getter: () => PythonEnv | undefined, dataDir?: string): void {
    this.pythonEnvDefault = getter;
    this.dataDir = dataDir;
  }

  /**
   * 按生效 nodeEnv/pythonEnv 并入工具链挂载（会话值 > 全局默认 > global）：
   * global node → readOnlyPaths（只读层，保持现状）；fnm/nvm 与 uv-config venv →
   * allowPaths（读写层，严格限定环境自身目录）。wsb/off 由 policyFor 关沙盒，挂载表被 core 忽略。
   */
  private withToolchainMounts(meta: SessionMeta | undefined, sandbox: SandboxPolicy): SandboxPolicy {
    const nodeMode = effectiveNodeEnv(meta?.nodeEnv, this.nodeEnvDefault?.());
    const pythonMode = effectivePythonEnv(meta?.pythonEnv, this.pythonEnvDefault?.());
    let next = sandbox;
    const readOnly = nodeEnvReadOnlyPaths(next.readOnlyPaths, nodeMode, this.platform);
    if (readOnly.length > (next.readOnlyPaths?.length ?? 0)) next = { ...next, readOnlyPaths: readOnly };
    const writeDirs = [
      ...nodeToolchainWritePaths(nodeMode, { platform: this.platform }),
      ...pythonEnvWritePaths(pythonMode, meta?.cwd, this.dataDir, this.platform),
    ];
    const writable = toolchainWritePaths(next.allowPaths, writeDirs);
    if (writable.length > (next.allowPaths?.length ?? 0)) next = { ...next, allowPaths: writable };
    return next;
  }
  /**
   * Core keeps session policy in process memory. Remember the desired host-side
   * request and which concrete client currently has it, so a restarted shared
   * core (or a newly acquired WSB core) is configured before its first tool
   * call. This also makes app.ts's idle-file cache safe across core restarts.
   */
  private readonly desiredConfigs = new Map<string, { sessionId: string; cwd: string; sandbox: SandboxPolicy }>();
  private readonly configuredClients = new Map<string, CoreClientLike>();
  private readonly configuring = new Map<string, { client: CoreClientLike; promise: Promise<void> }>();
  /** wsb 会话在宿主机 core 上的旁路配置（仅供 path.normalize 取 host canonical 路径）。 */
  private readonly hostNormalizeConfigs = new Set<string>();
  /** ptyId → 开出该 pty 的 core 客户端（各 core 独立编号，openPty 时登记）。 */
  private readonly ptyOwners = new Map<number, CoreClientLike>();
  /** sessionId → 最近一次 configureSession 成功后 core 上报的执行级别（REST 透出用）。 */
  private readonly sandboxStatus = new Map<string, { capability: string; reason?: string; at: number }>();

  constructor(
    private readonly shared: CoreClientLike,
    private readonly sessions: Pick<SessionStore, "get">,
    private readonly wsb: WsbManager,
    jobObject?: JobObjectLimits,
    allowPaths?: string[],
    platform?: NodeJS.Platform,
    /** filtered 网络档 sidecar 编排；未注入时 filtered 按普通策略下发（core 自行过滤）。 */
    private readonly filteredProxy?: FilteredProxyManager,
  ) {
    super();
    this.jobObject = jobObject;
    this.allowPaths = allowPaths;
    this.platform = platform ?? process.platform;
    this.forwardClientEvents(shared);
    this.wsb.onClientCreated = (_sessionId, client) => {
      this.forwardClientEvents(client, _sessionId);
    };
  }

  private forwardClientEvents(client: CoreClientLike, sessionId?: string): void {
    client.on("event", (event: unknown, ...args: unknown[]) => {
      if (isCoreLifecycleEvent(event)) this.invalidateClient(client, sessionId);
      this.emit("event", event, ...args);
    });
    for (const event of ["diagnostic", "error"]) {
      client.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }
  }

  private invalidateClient(client: CoreClientLike, sessionId?: string): void {
    if (client === this.shared) this.hostNormalizeConfigs.clear();
    if (sessionId && this.configuredClients.get(sessionId) === client) this.configuredClients.delete(sessionId);
    for (const [id, configured] of this.configuredClients) {
      if (configured === client) this.configuredClients.delete(id);
    }
    for (const [id, pending] of this.configuring) {
      if (pending.client === client) this.configuring.delete(id);
    }
    for (const [ptyId, owner] of this.ptyOwners) {
      if (owner === client) this.ptyOwners.delete(ptyId);
    }
  }

  /** sandboxMode → 下发给 core 的策略：wsb/off 由 VM/关闭充当边界；缺省为 jobobject 兼容模式（仅 Windows；POSIX core 无 mode 语义，未显式选择时不下发，避免 UI 展示 Windows 标签）；appcontainer 需显式选择；jobObject 限制仅随启用路径下发 */
  static policyFor(meta: SessionMeta | undefined, sandbox: SandboxPolicy, jobObject?: JobObjectLimits, allowPaths?: string[], platform: NodeJS.Platform = process.platform): SandboxPolicy {
    const mode = meta?.sandboxMode;
    // wsb 会话在 VM 内的 core 上配置：宿主侧 bindLinks 路径在 guest 无效，剥离（创建 REST 已拒绝 wsb+bindLinks，此为切换模式后的防御）
    if (mode === "wsb") {
      const { bindLinks: _stripped, ...rest } = sandbox;
      return { ...rest, enabled: false };
    }
    if (mode === "off") return { ...sandbox, enabled: false };
    const limits = {
      ...(allowPaths && allowPaths.length > 0 ? { allowPaths } : {}),
      ...(jobObject?.memoryMB !== undefined ? { jobMemoryMB: jobObject.memoryMB } : {}),
      ...(jobObject?.maxProcesses !== undefined ? { jobMaxProcesses: jobObject.maxProcesses } : {}),
    };
    const credentials = gitCredentialReadOnlyPaths(sandbox.readOnlyPaths, platform);
    const withCredentials = credentials.length > 0 ? { readOnlyPaths: credentials } : {};
    if (mode === "appcontainer") return { ...sandbox, ...withCredentials, ...limits, mode: "appcontainer" };
    // bubblewrap 显式下发（POSIX 专用；Windows 上的取值由 REST 校验拦截，这里不防御）
    if (mode === "bubblewrap") return { ...sandbox, ...withCredentials, ...limits, mode: "bubblewrap" };
    // landlock 与 POSIX 缺省都不下发 mode：core 缺省后端即 bubblewrap（无 bwrap 自动回落 Landlock）
    // 显式选择（含持久化里已存的 jobobject）原样下发；只有缺省决策按平台分流
    if (mode === "jobobject" || platform === "win32") return { ...sandbox, ...withCredentials, ...limits, mode: "jobobject" };
    return { ...sandbox, ...withCredentials, ...limits };
  }

  private async metaFor(sessionId: string): Promise<SessionMeta | undefined> {
    return this.sessions.get(sessionId).catch(() => undefined);
  }

  private async clientFor(sessionId: string): Promise<{ client: CoreClientLike; meta: SessionMeta | undefined }> {
    const meta = await this.metaFor(sessionId);
    // WSB 网络为 VM 启动参数（Networking Enable/Disable 二元）；会话策略 deny → 断网，其余（含未设置/filtered）保持联网
    if (meta?.sandboxMode === "wsb") return { client: await this.wsb.acquire(sessionId, meta, meta.sandbox?.network === "deny" ? "deny" : "allow"), meta };
    return { client: this.shared, meta };
  }

  private defaultConfig(meta: SessionMeta): { sessionId: string; cwd: string; sandbox: SandboxPolicy } {
    return {
      sessionId: meta.id,
      cwd: meta.cwd,
      sandbox: meta.sandbox ?? defaultSandboxPolicy(meta.cwd),
    };
  }

  private async configureClient(
    client: CoreClientLike,
    meta: SessionMeta | undefined,
    request: { sessionId: string; cwd: string; sandbox: SandboxPolicy },
  ): Promise<void> {
    // A tool may arrive during CoreClient's short exponential-restart delay.
    // start() is idempotent and either joins the live handshake or starts it
    // immediately, so do not leak a transient "Core is not running" failure.
    await client.start();
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    const routed = CoreRouter.policyFor(meta, request.sandbox, this.jobObject, this.allowPaths, this.platform);
    const result = await this.configureWithFiltered(client, request.sessionId, cwd, this.withToolchainMounts(meta, routed));
    // 重放配置（core 重启后）同样刷新执行级别透出，避免 /sandbox-status 陈旧
    this.sandboxStatus.set(request.sessionId, { capability: result.sandboxCapability, ...(result.sandboxReason !== undefined ? { reason: result.sandboxReason } : {}), at: Date.now() });
    this.configuredClients.set(request.sessionId, client);
  }

  /**
   * filtered 网络档两阶段下发：先下基础配置（sidecar job 需要已配置的会话上下文），
   * ensureProxy 拿到端口后补发 proxyAddr + readOnlyPaths；其余模式一次下发。
   * 仅宿主机 core 走 sidecar（REST 已门禁 wsb+filtered 组合）。
   */
  private async configureWithFiltered(
    client: CoreClientLike,
    sessionId: string,
    cwd: string,
    sandbox: SandboxPolicy,
  ): Promise<{ sandboxCapability: string; sandboxReason?: string }> {
    if (sandbox.network !== "filtered" || !this.filteredProxy || client !== this.shared) {
      return client.configureSession({ sessionId, cwd, sandbox });
    }
    await client.configureSession({ sessionId, cwd, sandbox });
    const { proxyAddr, readOnlyPaths } = await this.filteredProxy.ensureProxy(client, sessionId, cwd);
    // sidecar 目录必须可读（前置保证），与已并入的凭据/工具链挂载合并而非替换（core 上限 16）
    const mergedReadOnly = [...readOnlyPaths, ...(sandbox.readOnlyPaths ?? []).filter((entry) => !readOnlyPaths.includes(entry))].slice(0, 16);
    return client.configureSession({ sessionId, cwd, sandbox: { ...sandbox, proxyAddr, readOnlyPaths: mergedReadOnly } });
  }

  private async ensureConfigured(
    sessionId: string,
    selected?: { client: CoreClientLike; meta: SessionMeta | undefined },
  ): Promise<{ client: CoreClientLike; meta: SessionMeta | undefined }> {
    const target = selected ?? await this.clientFor(sessionId);
    if (this.configuredClients.get(sessionId) === target.client) return target;
    const existing = this.configuring.get(sessionId);
    if (existing?.client === target.client) {
      await existing.promise;
      return target;
    }
    const request = this.desiredConfigs.get(sessionId) ?? (target.meta ? this.defaultConfig(target.meta) : undefined);
    if (!request) return target;
    const promise = this.configureClient(target.client, target.meta, request);
    const pending = { client: target.client, promise };
    this.configuring.set(sessionId, pending);
    try {
      await promise;
    } finally {
      if (this.configuring.get(sessionId) === pending) this.configuring.delete(sessionId);
    }
    return target;
  }

  start(): Promise<CoreInfo> {
    return this.shared.start();
  }

  async stop(): Promise<void> {
    await this.wsb.releaseAll().catch(() => undefined);
    await this.shared.stop();
    this.configuredClients.clear();
    this.configuring.clear();
    this.ptyOwners.clear();
    this.sandboxStatus.clear();
  }

  ping(): Promise<CoreInfo> {
    return this.shared.ping();
  }

  /**
   * overlay.*：快照原语是会话无关的宿主机文件系统操作（stateRoot 根界），
   * 一律落在宿主机 core——WSB guest 不持有宿主文件系统，无路由歧义。
   */
  async overlayMount(request: OverlayMountRequest): Promise<OverlayMountResult> {
    if (!this.shared.overlayMount) throw new Error("Core overlay support is unavailable");
    return this.shared.overlayMount(request);
  }

  async overlayCheckpoint(request: OverlayCheckpointRequest): Promise<OverlayCopyResult> {
    if (!this.shared.overlayCheckpoint) throw new Error("Core overlay support is unavailable");
    return this.shared.overlayCheckpoint(request);
  }

  async overlayRestore(request: OverlayRestoreRequest): Promise<OverlayRestoreResult> {
    if (!this.shared.overlayRestore) throw new Error("Core overlay support is unavailable");
    return this.shared.overlayRestore(request);
  }

  async overlayUnmount(request: OverlayUnmountRequest): Promise<{ ok: true }> {
    if (!this.shared.overlayUnmount) throw new Error("Core overlay support is unavailable");
    return this.shared.overlayUnmount(request);
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    this.shared.setRequestTimeoutMs(timeoutMs);
  }

  /** 释放会话持有的沙盒 core（WSB 虚拟机蒸发）与 filtered sidecar；非 wsb/非 filtered 会话为 no-op。 */
  async release(sessionId: string): Promise<void> {
    this.configuredClients.delete(sessionId);
    this.configuring.delete(sessionId);
    this.sandboxStatus.delete(sessionId);
    if (this.filteredProxy) await this.filteredProxy.releaseProxy(this.shared, sessionId).catch(() => undefined);
    await this.wsb.release(sessionId);
  }

  async configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string; sandboxReason?: string }> {
    const { client, meta } = await this.clientFor(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    const routed = CoreRouter.policyFor(meta, request.sandbox, this.jobObject, this.allowPaths, this.platform);
    const result = await this.configureWithFiltered(client, request.sessionId, cwd, this.withToolchainMounts(meta, routed));
    this.desiredConfigs.set(request.sessionId, request);
    this.configuredClients.set(request.sessionId, client);
    this.sandboxStatus.set(request.sessionId, { capability: result.sandboxCapability, ...(result.sandboxReason !== undefined ? { reason: result.sandboxReason } : {}), at: Date.now() });
    return result;
  }

  /** 最近一次 configureSession 记录的会话执行级别；无记录（未配置/已释放）返回 undefined。 */
  sandboxStatusFor(sessionId: string): { capability: string; reason?: string; at: number } | undefined {
    return this.sandboxStatus.get(sessionId);
  }

  async cleanupSession(sessionId: string): Promise<{ ok: true }> {
    const meta = await this.metaFor(sessionId);
    if (meta?.sandboxMode === "wsb") {
      // 不为清理而启动虚拟机；沙盒 core 存在才通知（虚拟机整体由 release 回收）
      const client = this.wsb.peek(sessionId);
      if (client) await client.cleanupSession(sessionId).catch(() => undefined);
      if (this.hostNormalizeConfigs.delete(sessionId)) await this.shared.cleanupSession(sessionId).catch(() => undefined);
      this.desiredConfigs.delete(sessionId);
      this.configuredClients.delete(sessionId);
      this.configuring.delete(sessionId);
      this.sandboxStatus.delete(sessionId);
      return { ok: true };
    }
    // filtered sidecar 随会话清理回收（cancel job + 删 deny 文件，best effort）
    if (this.filteredProxy) await this.filteredProxy.releaseProxy(this.shared, sessionId).catch(() => undefined);
    const result = await this.shared.cleanupSession(sessionId);
    this.hostNormalizeConfigs.delete(sessionId);
    this.desiredConfigs.delete(sessionId);
    this.configuredClients.delete(sessionId);
    this.configuring.delete(sessionId);
    this.sandboxStatus.delete(sessionId);
    return result;
  }

  /**
   * path.normalize：非 wsb 会话按正常路由；wsb 会话的 canonical host 路径只能由
   * 宿主机 core 归一化（guest core 的 cwd 是挂载点），为此在宿主机 core 上做一份
   * 旁路 session 配置（仅服务于 normalize，不参与 fs 路由）。
   */
  async normalizePath(request: PathNormalizeRequest): Promise<PathNormalizeResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    if (meta?.sandboxMode === "wsb") return this.normalizeOnHost(request.sessionId, request.path, request.purpose, meta);
    if (!client.normalizePath) throw new Error("Core path.normalize support is unavailable");
    return client.normalizePath(request);
  }

  private async normalizeOnHost(sessionId: string, path: string, purpose: "read" | "write" | undefined, meta: SessionMeta | undefined): Promise<PathNormalizeResult> {
    if (!this.shared.normalizePath) throw new Error("Core path.normalize support is unavailable");
    if (!this.hostNormalizeConfigs.has(sessionId)) {
      const desired = this.desiredConfigs.get(sessionId) ?? (meta ? this.defaultConfig(meta) : undefined);
      if (!desired) throw new Error("session was not configured");
      await this.shared.start();
      await this.shared.configureSession(desired);
      this.hostNormalizeConfigs.add(sessionId);
    }
    return this.shared.normalizePath({ sessionId, path, ...(purpose ? { purpose } : {}) });
  }

  private async translatePath<T extends { sessionId: string; path: string }>(request: T, meta: SessionMeta | undefined): Promise<T> {
    if (meta?.sandboxMode !== "wsb" || !meta.cwd) return request;
    let path = request.path;
    if (needsHostNormalize(path)) {
      try {
        path = (await this.normalizeOnHost(request.sessionId, path, undefined, meta)).path;
      } catch { /* normalize 不可用/失败：回退原始字符串，guest core 会按策略拒绝越界 */ }
    }
    return { ...request, path: toSandboxPath(path, meta.cwd) };
  }

  async run(request: ExecRequest): Promise<ExecResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.run({ ...request, cwd });
  }

  async readFile(request: FsReadRequest): Promise<FsReadResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.readFile(await this.translatePath(request, meta));
  }

  async writeFile(request: FsWriteRequest): Promise<{ ok: true }> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.writeFile(await this.translatePath(request, meta));
  }

  async writeFileBase64(request: FsWriteBase64Request): Promise<{ ok: true }> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    if (!client.writeFileBase64) throw new Error("Core binary upload support is unavailable");
    return client.writeFileBase64(await this.translatePath(request, meta));
  }

  async readFileBase64(request: FsPathRequest): Promise<FsReadBase64Result> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    if (!client.readFileBase64) throw new Error("Core binary read support is unavailable");
    return client.readFileBase64(await this.translatePath(request, meta));
  }

  async editFile(request: FsEditRequest): Promise<{ matches: number }> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.editFile(await this.translatePath(request, meta));
  }

  async statFile(request: FsPathRequest): Promise<FsStatResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.statFile(await this.translatePath(request, meta));
  }

  async statFiles(request: FsStatManyRequest): Promise<FsStatManyResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const translated = await Promise.all(request.paths.map((path) => this.translatePath({ sessionId: request.sessionId, path }, meta)));
    return client.statFiles({ ...request, paths: translated.map((entry) => entry.path) });
  }

  async hashFile(request: FsPathRequest): Promise<FsHashResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.hashFile(await this.translatePath(request, meta));
  }

  async scanFiles(request: FsScanRequest): Promise<FsScanResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.scanFiles(await this.translatePath(request, meta));
  }

  async watchFiles(request: FsWatchRequest): Promise<{ watchId: number }> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.watchFiles(await this.translatePath(request, meta));
  }

  async pollWatch(request: FsWatchPollRequest): Promise<FsWatchPollResult> {
    const { client } = await this.ensureConfigured(request.sessionId);
    return client.pollWatch(request);
  }

  async cancelWatch(request: { sessionId: string; watchId: number }): Promise<{ ok: true }> {
    const { client } = await this.ensureConfigured(request.sessionId);
    return client.cancelWatch(request);
  }

  async startJob(request: JobStartRequest): Promise<JobStatus> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.startJob({ ...request, cwd });
  }

  async startIndexScan(request: IndexScanStartRequest): Promise<JobStatus> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.startIndexScan(await this.translatePath({ ...request, cwd }, meta));
  }

  async startGrepJob(request: GrepJobStartRequest): Promise<JobStatus> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.startGrepJob(await this.translatePath({ ...request, cwd }, meta));
  }

  async startGlobJob(request: GlobJobStartRequest): Promise<JobStatus> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.startGlobJob(await this.translatePath({ ...request, cwd }, meta));
  }

  async startIndexExtract(request: IndexExtractStartRequest): Promise<JobStatus> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.startIndexExtract(await this.translatePath({ ...request, cwd }, meta));
  }

  async cancelJob(request: { sessionId: string; jobId: string }): Promise<{ jobId: string; accepted: true }> {
    const { client } = await this.ensureConfigured(request.sessionId);
    return client.cancelJob(request);
  }

  async jobStatus(request: { sessionId: string; jobId: string }): Promise<JobStatus> {
    const { client } = await this.ensureConfigured(request.sessionId);
    return client.jobStatus(request);
  }

  async jobOutput(request: JobOutputRequest): Promise<JobOutputResult> {
    const { client } = await this.ensureConfigured(request.sessionId);
    return client.jobOutput(request);
  }

  async listFiles(request: FsPathRequest): Promise<FsListResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.listFiles(await this.translatePath(request, meta));
  }

  async globFiles(request: FsSearchRequest): Promise<FsGlobResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.globFiles(await this.translatePath(request, meta));
  }

  async grepFiles(request: FsSearchRequest): Promise<FsGrepResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    return client.grepFiles(await this.translatePath(request, meta));
  }

  searchJob(request: SearchJobRequest & { kind: "glob" }): Promise<FsGlobResult>;
  searchJob(request: SearchJobRequest & { kind: "grep" }): Promise<FsGrepResult>;
  async searchJob(request: SearchJobRequest & { kind: "grep" | "glob" }): Promise<FsGlobResult | FsGrepResult> {
    const { client, meta } = await this.ensureConfigured(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    // 底层 client 无 searchJob 实现（fake/旧装配）时回退同步 fs.glob/fs.grep
    if (request.kind === "glob") {
      const translated = await this.translatePath({ ...request, cwd, kind: "glob" as const }, meta);
      if (client.searchJob) return client.searchJob(translated);
      return client.globFiles({ sessionId: translated.sessionId, path: translated.path, pattern: translated.pattern });
    }
    const translated = await this.translatePath({ ...request, cwd, kind: "grep" as const }, meta);
    if (client.searchJob) return client.searchJob(translated);
    return client.grepFiles({ sessionId: translated.sessionId, path: translated.path, pattern: translated.pattern });
  }

  /**
   * pty.*：路由到会话所属 core（wsb 会话在 VM 内的 core 上开终端，cwd 做挂载翻译）。
   * ptyId 由各 core 独立编号，ptyOwners 记录归属；两个 core 并发开出同一 id 时
   * 后开者覆盖归属（人类终端并发量极低，注释存档该限制）。
   */
  async openPty(request: PtyOpenRequest): Promise<PtyOpenResult> {
    const { client, meta } = await this.ensureConfigured(request.session);
    if (!client.openPty) throw new Error("Core pty support is unavailable");
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    const result = await client.openPty({ ...request, cwd });
    this.ptyOwners.set(result.ptyId, client);
    return result;
  }

  async inputPty(request: PtyInputRequest): Promise<{ ok: true }> {
    const client = this.ptyOwners.get(request.ptyId) ?? this.shared;
    if (!client.inputPty) throw new Error("Core pty support is unavailable");
    return client.inputPty(request);
  }

  async resizePty(request: PtyResizeRequest): Promise<{ ok: true }> {
    const client = this.ptyOwners.get(request.ptyId) ?? this.shared;
    if (!client.resizePty) throw new Error("Core pty support is unavailable");
    return client.resizePty(request);
  }

  async closePty(request: { ptyId: number }): Promise<{ ok: true; exitCode?: number }> {
    const client = this.ptyOwners.get(request.ptyId) ?? this.shared;
    this.ptyOwners.delete(request.ptyId);
    if (!client.closePty) throw new Error("Core pty support is unavailable");
    return client.closePty(request);
  }

  ptyEvents(ptyId: number): EventEmitter {
    const client = this.ptyOwners.get(ptyId) ?? this.shared;
    if (!client.ptyEvents) throw new Error("Core pty support is unavailable");
    return client.ptyEvents(ptyId);
  }

  removePtyEvents(ptyId: number): void {
    this.ptyOwners.delete(ptyId);
    this.shared.removePtyEvents?.(ptyId);
  }
}

function isCoreLifecycleEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "core.exit" || type === "core.ready";
}
