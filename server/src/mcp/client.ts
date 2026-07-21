import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "./config.js";
import { isHttpConfig } from "./config.js";

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: string;
  isError: boolean;
}

export interface McpClient {
  serverName: string;
  listTools(): Promise<McpToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2025-06-18";

/** 抽取 tools/call 结果：全文本块拼接，混合块序列化为 JSON。 */
function renderContent(result: unknown): McpToolCallResult {
  const record = (result ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const blocks = Array.isArray(record.content) ? record.content : [];
  const textParts = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text!);
  const content = textParts.length === blocks.length ? textParts.join("\n") : JSON.stringify(blocks);
  return { content, isError: record.isError === true };
}

class Client implements McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private sessionId?: string;
  private closed = false;
  readonly ready: Promise<void>;

  constructor(readonly serverName: string, private readonly config: McpServerConfig, private readonly timeoutMs: number) {
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    if (!isHttpConfig(this.config)) {
      const { command, args = [], env, cwd } = this.config;
      this.child = spawn(command, args, {
        env: { ...process.env, ...env },
        ...(cwd ? { cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout.setEncoding("utf8");
      this.child.stderr.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      // 进程已退出时写 stdin 触发 EPIPE：由 exit 处理器统一失败化，这里只吸收流错误
      this.child.stdin.on("error", () => {});
      this.child.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });
      this.child.on("error", (error) => this.failAll(new Error(`MCP server ${this.serverName} 启动失败：${error.message}`)));
      this.child.on("exit", (code) => {
        if (!this.closed) this.failAll(new Error(`MCP server ${this.serverName} 已退出（code ${code}）${this.stderrTail ? `：${this.stderrTail.trim()}` : ""}`));
      });
    }
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "openwebcode", version: "0.2.1" },
    });
    this.notify("notifications/initialized");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      try {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 非 JSON 行（服务器打印的日志）：忽略
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      const rpcError = message.error as { code?: number; message?: string } | undefined;
      if (rpcError) entry.reject(new Error(`MCP ${this.serverName} 错误 ${rpcError.code ?? ""}: ${rpcError.message ?? "unknown"}`));
      else entry.resolve(message.result);
    }
    // 服务器主动请求/通知（roots/list、tools/list_changed 等）v0.1 不响应
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private sendRpc(message: Record<string, unknown>): void {
    if (this.closed) throw new Error(`MCP server ${this.serverName} 连接已关闭`);
    if (isHttpConfig(this.config)) void this.postHttp(message);
    else {
      if (!this.child) throw new Error(`MCP server ${this.serverName} 未启动`);
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private async postHttp(message: Record<string, unknown>): Promise<void> {
    const config = this.config;
    if (!isHttpConfig(config)) return;
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...config.headers,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const sessionHeader = response.headers.get("mcp-session-id");
      if (sessionHeader) this.sessionId = sessionHeader;
      if (message.id === undefined) return; // 通知：202/空响应属正常（会话 id 已在上方捕获）
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const text = await response.text();
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data === "") continue;
          try {
            this.handleMessage(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // 非 JSON 的 SSE 数据：忽略
          }
        }
      } else {
        this.handleMessage(await response.json() as Record<string, unknown>);
      }
    } catch (error) {
      // HTTP 传输错误：该消息对应的 pending 由超时兜底；主动失败化以快速反馈
      if (typeof message.id === "number") {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.serverName} 请求 ${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.sendRpc({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.sendRpc({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    } catch {
      // 通知发送失败不致命
    }
  }

  async listTools(): Promise<McpToolSpec[]> {
    await this.ready;
    const result = await this.request("tools/list") as { tools?: McpToolSpec[] };
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.ready;
    return renderContent(await this.request("tools/call", { name, arguments: args }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`MCP server ${this.serverName} 连接已关闭`));
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}

/** 建立连接并完成 initialize 握手；失败时抛错（由调用方做降级）。 */
export async function connectMcpServer(name: string, config: McpServerConfig, options: { timeoutMs?: number } = {}): Promise<McpClient> {
  const client = new Client(name, config, options.timeoutMs ?? 30_000);
  try {
    await client.ready;
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}
