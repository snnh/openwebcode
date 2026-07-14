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
  generation: number;
}

export class CoreRpcError extends Error {
  constructor(readonly code: number, message: string) {
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
  private generation = 0;
  private failedGeneration = 0;

  constructor(
    private readonly corePath: string,
    private readonly requestTimeoutMs = 130_000,
  ) {
    super();
  }

  start(): Promise<CoreInfo> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    const generation = ++this.generation;
    this.startPromise = this.spawnAndHandshake(generation).catch((error: unknown) => {
      this.failConnection(generation, error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const generation = this.generation;
    const transport = this.transport;
    if (transport) {
      try {
        await this.call("core.shutdown", {}, 5_000);
      } catch {
        this.child?.kill();
      }
      try {
        await transport.close();
      } catch {
        this.child?.kill();
      }
    }
    this.failConnection(generation, new Error("Core client stopped"), false);
    this.startPromise = undefined;
  }

  ping(): Promise<CoreInfo> {
    return this.call<CoreInfo>("core.ping", {});
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return this.call<ExecResult>("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
  }

  private async spawnAndHandshake(generation: number): Promise<CoreInfo> {
    const executable = this.resolveCorePath();
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const transport = new StdioTransport(child);
    this.child = child;
    this.transport = transport;
    transport.on("message", (message) => this.onMessage(generation, message));
    transport.on("diagnostic", (text) => this.emit("diagnostic", text));
    transport.on("error", (error) => this.failConnection(generation, normalizeError(error)));
    transport.on("close", (details) => this.failConnection(generation, new Error("Core process exited"), true, details));
    const info = await this.ping();
    if (generation !== this.generation || this.failedGeneration === generation) throw new Error("Core process exited during handshake");
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
    const generation = this.generation;
    if (!transport || this.failedGeneration === generation) return Promise.reject(new Error("Core is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Core request ${method} timed out`);
        this.failConnection(generation, error);
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, generation });
      try {
        transport.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.failConnection(generation, normalizeError(error));
      }
    });
  }

  private onMessage(generation: number, message: unknown): void {
    if (generation !== this.generation || !message || typeof message !== "object") return;
    if ("method" in message) {
      const notification = message as { jsonrpc?: unknown; method?: unknown; params?: unknown };
      if (notification.jsonrpc !== "2.0" || typeof notification.method !== "string") {
        this.failConnection(generation, new Error("Malformed RPC notification"));
        return;
      }
      this.emitEvent(notification.method, notification.params);
      return;
    }
    const response = message as Partial<RpcResponse>;
    if (response.jsonrpc !== "2.0" || typeof response.id !== "number") {
      this.failConnection(generation, new Error("Malformed RPC response"));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
    const hasError = Object.prototype.hasOwnProperty.call(response, "error");
    if (hasResult === hasError || (hasError && !isRpcError(response.error))) {
      this.failConnection(generation, new Error("Malformed RPC response"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending || pending.generation !== generation) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (hasError && response.error) pending.reject(new CoreRpcError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  private failConnection(generation: number, error: Error, restart = true, details?: unknown): void {
    if (generation !== this.generation || this.failedGeneration === generation) return;
    this.failedGeneration = generation;
    const child = this.child;
    this.transport = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (child && child.exitCode === null) child.kill();
    this.emitEvent("core.exit", details ?? { message: error.message });
    if (this.stopping || !restart || this.restartCount >= 3) return;
    const delay = 250 * 2 ** this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch((restartError: unknown) => this.emit("error", normalizeError(restartError)));
    }, delay);
  }

  private emitEvent(type: string, payload: unknown): void {
    const event: CoreEvent = { source: "core", type, payload };
    this.emit("event", event);
  }
}

function isRpcError(value: unknown): value is RpcErrorBody {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as RpcErrorBody).code === "number" &&
    typeof (value as RpcErrorBody).message === "string";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
