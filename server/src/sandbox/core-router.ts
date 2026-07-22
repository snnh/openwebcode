import { EventEmitter } from "node:events";
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
  FsReadRequest,
  FsReadResult,
  FsSearchRequest,
  FsHashResult,
  FsStatResult,
  FsStatManyRequest,
  FsStatManyResult,
  FsWriteBase64Request,
  FsWriteRequest,
} from "../core-client.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { JobObjectLimits, SandboxPolicy, SessionMeta } from "../sessions/types.js";
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

/** wsb 会话的请求路径翻译；其余会话原样返回 */
function translatePath<T extends { path: string }>(request: T, meta: SessionMeta | undefined): T {
  if (meta?.sandboxMode !== "wsb" || !meta.cwd) return request;
  return { ...request, path: toSandboxPath(request.path, meta.cwd) };
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

  constructor(
    private readonly shared: CoreClientLike,
    private readonly sessions: Pick<SessionStore, "get">,
    private readonly wsb: WsbManager,
    jobObject?: JobObjectLimits,
    allowPaths?: string[],
  ) {
    super();
    this.jobObject = jobObject;
    this.allowPaths = allowPaths;
    for (const event of ["event", "diagnostic", "error"]) {
      shared.on(event, (...args: unknown[]) => this.emit(event, ...args));
    }
    this.wsb.onClientCreated = (_sessionId, client) => {
      for (const event of ["event", "diagnostic", "error"]) {
        client.on(event, (...args: unknown[]) => this.emit(event, ...args));
      }
    };
  }

  /** sandboxMode → 下发给 core 的策略：wsb/off 由 VM/关闭充当边界；jobobject 下发兼容模式；jobObject 限制仅随启用路径下发 */
  static policyFor(meta: SessionMeta | undefined, sandbox: SandboxPolicy, jobObject?: JobObjectLimits, allowPaths?: string[]): SandboxPolicy {
    const mode = meta?.sandboxMode;
    if (mode === "wsb" || mode === "off") return { ...sandbox, enabled: false };
    const limits = {
      ...(allowPaths && allowPaths.length > 0 ? { allowPaths } : {}),
      ...(jobObject?.memoryMB !== undefined ? { jobMemoryMB: jobObject.memoryMB } : {}),
      ...(jobObject?.maxProcesses !== undefined ? { jobMaxProcesses: jobObject.maxProcesses } : {}),
    };
    if (mode === "jobobject") return { ...sandbox, ...limits, mode: "jobobject" };
    return { ...sandbox, ...limits };
  }

  private async metaFor(sessionId: string): Promise<SessionMeta | undefined> {
    return this.sessions.get(sessionId).catch(() => undefined);
  }

  private async clientFor(sessionId: string): Promise<{ client: CoreClientLike; meta: SessionMeta | undefined }> {
    const meta = await this.metaFor(sessionId);
    if (meta?.sandboxMode === "wsb") return { client: await this.wsb.acquire(sessionId, meta), meta };
    return { client: this.shared, meta };
  }

  start(): Promise<CoreInfo> {
    return this.shared.start();
  }

  async stop(): Promise<void> {
    await this.wsb.releaseAll().catch(() => undefined);
    await this.shared.stop();
  }

  ping(): Promise<CoreInfo> {
    return this.shared.ping();
  }

  setRequestTimeoutMs(timeoutMs: number): void {
    this.shared.setRequestTimeoutMs(timeoutMs);
  }

  /** 释放会话持有的沙盒 core（WSB 虚拟机蒸发）；非 wsb 会话为 no-op。 */
  async release(sessionId: string): Promise<void> {
    await this.wsb.release(sessionId);
  }

  async configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string }> {
    const { client, meta } = await this.clientFor(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.configureSession({ ...request, cwd, sandbox: CoreRouter.policyFor(meta, request.sandbox, this.jobObject, this.allowPaths) });
  }

  async cleanupSession(sessionId: string): Promise<{ ok: true }> {
    const meta = await this.metaFor(sessionId);
    if (meta?.sandboxMode === "wsb") {
      // 不为清理而启动虚拟机；沙盒 core 存在才通知（虚拟机整体由 release 回收）
      const client = this.wsb.peek(sessionId);
      if (client) await client.cleanupSession(sessionId).catch(() => undefined);
      return { ok: true };
    }
    return this.shared.cleanupSession(sessionId);
  }

  async run(request: ExecRequest): Promise<ExecResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
    return client.run({ ...request, cwd });
  }

  async readFile(request: FsReadRequest): Promise<FsReadResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.readFile(translatePath(request, meta));
  }

  async writeFile(request: FsWriteRequest): Promise<{ ok: true }> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.writeFile(translatePath(request, meta));
  }

  async writeFileBase64(request: FsWriteBase64Request): Promise<{ ok: true }> {
    const { client, meta } = await this.clientFor(request.sessionId);
    if (!client.writeFileBase64) throw new Error("Core binary upload support is unavailable");
    return client.writeFileBase64(translatePath(request, meta));
  }

  async editFile(request: FsEditRequest): Promise<{ matches: number }> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.editFile(translatePath(request, meta));
  }

  async statFile(request: FsPathRequest): Promise<FsStatResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.statFile(translatePath(request, meta));
  }

  async statFiles(request: FsStatManyRequest): Promise<FsStatManyResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.statFiles({
      ...request,
      paths: request.paths.map((path) => translatePath({ sessionId: request.sessionId, path }, meta).path),
    });
  }

  async hashFile(request: FsPathRequest): Promise<FsHashResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.hashFile(translatePath(request, meta));
  }

  async listFiles(request: FsPathRequest): Promise<FsListResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.listFiles(translatePath(request, meta));
  }

  async globFiles(request: FsSearchRequest): Promise<FsGlobResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.globFiles(translatePath(request, meta));
  }

  async grepFiles(request: FsSearchRequest): Promise<FsGrepResult> {
    const { client, meta } = await this.clientFor(request.sessionId);
    return client.grepFiles(translatePath(request, meta));
  }
}
