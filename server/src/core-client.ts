import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioTransport, type RpcTransport } from "./rpc/transport.js";

interface RpcErrorBody {
  code: number;
  message: string;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcErrorBody;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface CoreInfo {
  version: string;
  platform: "windows" | "linux";
  sandboxCapability: string;
}

export interface ExecRequest {
  sessionId: string;
  execId: string;
  cmd: string;
  cwd: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface CoreEvent {
  source: "core";
  type: string;
  payload: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CoreRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CoreRpcError";
  }
}

export class CoreClient extends EventEmitter {
  private transport: RpcTransport | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<CoreInfo> | undefined;

  constructor(
    private readonly corePath: string,
    private readonly requestTimeoutMs = 130_000,
  ) {
    super();
  }

  start(): Promise<CoreInfo> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.spawnAndHandshake();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (!this.transport) return;
    try {
      await this.call("core.shutdown", {}, 5_000);
    } catch {
      this.child?.kill();
    }
    await this.transport.close();
    this.transport = undefined;
    this.child = undefined;
    this.startPromise = undefined;
  }

  ping(): Promise<CoreInfo> {
    return this.call<CoreInfo>("core.ping", {});
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return this.call<ExecResult>("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
  }

  private async spawnAndHandshake(): Promise<CoreInfo> {
    const executable = this.resolveCorePath();
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const transport = new StdioTransport(child);
    this.transport = transport;
    transport.on("message", (message) => this.onMessage(message));
    transport.on("diagnostic", (text) => this.emit("diagnostic", text));
    transport.on("error", (error) => this.emit("error", error));
    transport.on("close", (details) => this.onClose(details));
    const info = await this.ping();
    this.restartCount = 0;
    this.emitEvent("core.ready", info);
    return info;
  }

  private resolveCorePath(): string {
    if (path.isAbsolute(this.corePath)) return this.corePath;
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDirectory, "..", this.corePath);
  }

  private call<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error("Core is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Core request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      transport.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    if ("method" in message) {
      const notification = message as RpcNotification;
      this.emitEvent(notification.method, notification.params);
      return;
    }
    const response = message as RpcResponse;
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) pending.reject(new CoreRpcError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  private emitEvent(type: string, payload: unknown): void {
    const event: CoreEvent = { source: "core", type, payload };
    this.emit("event", event);
  }

  private onClose(details: unknown): void {
    this.transport = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    const error = new Error("Core process exited");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emitEvent("core.exit", details);
    if (this.stopping || this.restartCount >= 3) return;
    const delay = 250 * 2 ** this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.start().catch((restartError: unknown) => this.emit("error", restartError));
    }, delay);
  }
}
