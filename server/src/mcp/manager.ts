import type { ProviderTool } from "../providers/provider.js";
import { loadMcpConfig, type McpServerConfig } from "./config.js";
import { connectMcpServer, type McpClient, type McpToolCallResult, type McpToolSpec } from "./client.js";

interface ServerEntry {
  config: McpServerConfig;
  /** JSON.stringify(config)：配置变化时丢弃旧连接重建。 */
  configKey: string;
  client: McpClient | undefined;
  connecting: Promise<McpClient> | undefined;
  tools: McpToolSpec[];
  lastUsed: number;
}

interface Binding {
  server: string;
  tool: string;
  /** 连接被空闲回收后按此配置重建。 */
  config: McpServerConfig;
}

export interface McpToolBinding {
  tools: ProviderTool[];
  /** 连接/配置失败的降级说明（该 server 工具不注入）。 */
  warnings: string[];
}

const entryKey = (cwd: string, name: string): string => `${cwd}${name}`;

/**
 * MCP 连接管理器：连接与工具绑定都按 (cwd, server) 隔离——不同工作目录的
 * 并发会话互不影响（同名 server 在不同目录可以有不同配置）。
 * 惰性连接，配置变化自动重连，空闲超时断开（下次使用重建）。
 * plan §2.8：失败降级——单个 server 失败只产生 warning，不影响其他 server 与会话本身。
 */
export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly bindingsByCwd = new Map<string, Map<string, Binding>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly dataDir: string, private readonly options: { idleMs?: number; timeoutMs?: number; sweepMs?: number } = {}) {
    this.sweeper = setInterval(() => void this.sweepIdle(), this.options.sweepMs ?? 60_000);
    this.sweeper.unref();
  }

  async toolsFor(cwd: string): Promise<McpToolBinding> {
    const { servers, skipped } = await loadMcpConfig(this.dataDir, cwd);
    const warnings: string[] = skipped.map((name) => `MCP server「${name}」配置非法，已跳过`);
    // 本 cwd 配置中已移除的 server：断开并清理
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${cwd}`)) continue;
      if (!servers[key.slice(cwd.length + 1)]) {
        void entry.client?.close();
        this.entries.delete(key);
      }
    }
    const bindings = new Map<string, Binding>();
    this.bindingsByCwd.set(cwd, bindings);
    const tools: ProviderTool[] = [];
    for (const [name, config] of Object.entries(servers)) {
      try {
        const entry = await this.ensure(cwd, name, config);
        for (const tool of entry.tools) {
          const namespaced = `mcp__${name}__${tool.name}`;
          bindings.set(namespaced, { server: name, tool: tool.name, config });
          tools.push({
            name: namespaced,
            description: `[${name}] ${tool.description ?? tool.name}`,
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          });
        }
      } catch (error) {
        warnings.push(`MCP server「${name}」连接失败，其工具未注入：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { tools, warnings };
  }

  private async ensure(cwd: string, name: string, config: McpServerConfig): Promise<ServerEntry> {
    const key = entryKey(cwd, name);
    const configKey = JSON.stringify(config);
    let entry = this.entries.get(key);
    if (entry && entry.configKey !== configKey) {
      await entry.client?.close();
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { config, configKey, client: undefined, connecting: undefined, tools: [], lastUsed: Date.now() };
      this.entries.set(key, entry);
    }
    if (!entry.client) {
      // 连接建立期间即视为活跃：否则慢速握手会被空闲扫描误判并关掉新连接
      entry.lastUsed = Date.now();
      entry.connecting ??= connectMcpServer(name, config, { ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}) })
        .then(async (client) => {
          entry!.client = client;
          entry!.tools = await client.listTools();
          entry!.connecting = undefined;
          return client;
        })
        .catch((error: unknown) => {
          entry!.connecting = undefined;
          throw error;
        });
      await entry.connecting;
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  async callTool(cwd: string, namespaced: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    const binding = this.bindingsByCwd.get(cwd)?.get(namespaced);
    if (!binding) throw new Error(`Unknown MCP tool: ${namespaced}`);
    // 空闲断开后按需重连（binding.config 兜底，entry 被回收也能重建）
    const entry = await this.ensure(cwd, binding.server, binding.config);
    return entry.client!.callTool(binding.tool, input);
  }

  private async sweepIdle(): Promise<void> {
    const idleMs = this.options.idleMs ?? 600_000;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.connecting) continue;
      if (entry.client && now - entry.lastUsed > idleMs) {
        await entry.client.close();
        entry.client = undefined;
        entry.lastUsed = now;
      }
      // 无连接的空壳 entry 超时后移除（绑定里的 config 可随时重建）
      if (!entry.client && now - entry.lastUsed > idleMs) this.entries.delete(key);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.entries.values()].map((entry) => entry.client?.close()));
    this.entries.clear();
    this.bindingsByCwd.clear();
  }
}
