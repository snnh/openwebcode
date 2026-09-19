/**
 * dsh 兼容模式的运行期装配（M4 步骤 16）：按设置启停独立端口服务。
 *
 * 开关语义（与计划一致）：
 *   - `dshCompatEnabled=false`（默认）：进程内零常驻——端口不监听、不加载 vendor、不建事件桥；
 *   - 打开时：按 `dshPort`（默认 3211）监听；`dshUiPath` 非空时用自选目录代替内置 vendor；
 *   - vendor 缺失：不监听，如实记一条原因（不半启动），设置页据此提示先跑 fetch 脚本；
 *   - 热切换：设置更新事件触发 `sync()`，幂等（状态未变不动）。
 */
import path from "node:path";
import type { AgentRunner } from "../../agent/agent-runner.js";
import type { EventBus } from "../../events/event-bus.js";
import type { SessionStore } from "../../sessions/session-store.js";
import { buildDshServer, type DshServer } from "./server.js";
import type { DshWireDeps } from "./streams.js";

export interface DshCompatRuntimeOptions {
  /** 内置 vendor 目录（`server/assets/dsh-web`）。 */
  vendorDirectory: string;
  enabled: () => boolean;
  port: () => number;
  /** 自选 UI 目录（设置 `dshUiPath`）；非空时覆盖内置 vendor。 */
  uiPath: () => string | null;
  host: () => string;
  accessToken: () => string | undefined;
  sessions: SessionStore;
  agent: AgentRunner;
  events: EventBus;
  home: string;
  imageLimits?: DshWireDeps["projection"]["imageLimits"];
  logger?: { warn(message: string): void; info(message: string): void };
}

/** 缺省端口（与 docs/dsh-protocol-map.md §5.2 一致）。 */
export const DEFAULT_DSH_PORT = 3211;

export class DshCompatRuntime {
  private server: DshServer | undefined;
  private starting: Promise<void> | undefined;
  /** 上次尝试的 (enabled, vendorDirectory, port) 组合，用于幂等判断。 */
  private applied: string | undefined;

  constructor(private readonly options: DshCompatRuntimeOptions) {}

  /** 当前是否在监听（诊断/测试用）。 */
  get listening(): boolean {
    return this.server !== undefined;
  }

  /** 按当前设置对齐运行状态（幂等；并发调用合并）。 */
  async sync(): Promise<void> {
    if (this.starting !== undefined) {
      await this.starting;
      return;
    }
    const desired = this.desiredKey();
    if (desired === this.applied) return;
    this.starting = this.apply();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.applied = undefined;
    if (server !== undefined) await server.close();
  }

  private desiredKey(): string {
    const uiPath = this.options.uiPath();
    const vendor = uiPath !== null && uiPath.trim() !== "" ? path.resolve(uiPath) : this.options.vendorDirectory;
    return `${this.options.enabled() ? "on" : "off"}|${vendor}|${this.options.port()}`;
  }

  private log(message: string): void {
    (this.options.logger?.info ?? (() => {}))(message);
  }

  private warn(message: string): void {
    (this.options.logger?.warn ?? (() => {}))(message);
  }

  private async apply(): Promise<void> {
    const wantEnabled = this.options.enabled();
    // 先停旧实例（端口/目录都可能已变），再按需起新实例
    if (this.server !== undefined) {
      await this.server.close();
      this.server = undefined;
    }
    if (!wantEnabled) {
      this.applied = this.desiredKey();
      return;
    }
    const uiPath = this.options.uiPath();
    const vendorDirectory = uiPath !== null && uiPath.trim() !== "" ? path.resolve(uiPath) : this.options.vendorDirectory;
    const deps: DshWireDeps = {
      projection: {
        sessions: this.options.sessions,
        agent: this.options.agent,
        defaultCwd: this.options.home,
        ...(this.options.imageLimits === undefined ? {} : { imageLimits: this.options.imageLimits }),
      },
      events: this.options.events,
      home: this.options.home,
      respondPermission: async (sessionId, requestId, decision, reason) => {
        const complete = await this.options.agent.preparePermissionResponse(sessionId, requestId, decision, reason);
        // 批准后必须调用 complete() 才会恢复工具执行（与 REST 应答路径一致）
        complete?.();
      },
      respondInteraction: async (sessionId, requestId, answer) => {
        await this.options.agent.respondInteraction(sessionId, requestId, answer);
      },
      logger: { warn: (message) => this.warn(message) },
    };
    const server = await buildDshServer({
      vendorDirectory,
      enabled: () => this.options.enabled(),
      accessToken: this.options.accessToken(),
      deps,
      logger: { warn: (message) => this.warn(message), info: (message) => this.log(message) },
    });
    if (server === undefined) {
      this.warn(`[dsh] 未找到 dsh UI 产物（${vendorDirectory}）：先运行 node scripts/fetch-dsh-web.mjs 再打开该模式`);
      this.applied = this.desiredKey();
      return;
    }
    const address = await server.listen(this.options.host(), this.options.port());
    this.server = server;
    this.applied = this.desiredKey();
    this.log(`[dsh] 兼容模式已启动：http://${address}/ （dsh UI ${server.manifest.dshVersion}，${server.manifest.plugins.length} 个插件）`);
  }
}
