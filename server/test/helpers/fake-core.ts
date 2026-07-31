import { EventEmitter } from "node:events";
import type { CoreClientLike, CoreEvent, CoreInfo, ExecRequest, ExecResult } from "../../src/core-client.js";

/** 通用 fake core.ping/start 返回值（sandbox advisory、全 fs 能力、无 jobControl）。 */
export const FAKE_CORE_INFO: CoreInfo = {
  version: "0.2.4-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

/**
 * 默认空实现的 fake CoreClientLike：所有 fs 方法返回空结果，run 立即成功。
 * overrides 按方法覆盖（如 readFile 返回指定内容、run 挂起等）。
 */
export function makeFakeCore(overrides: Partial<CoreClientLike> = {}): CoreClientLike {
  const client: CoreClientLike = {
    on() { return client; },
    async start() { return FAKE_CORE_INFO; },
    async stop() { /* no-op */ },
    async ping() { return FAKE_CORE_INFO; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, truncated: false } as unknown as ExecResult; },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() { /* no-op */ },
    ...overrides,
  } as unknown as CoreClientLike;
  return client;
}

export interface ControllableCore {
  client: CoreClientLike;
  /** 完成挂起的 run() */
  release: (result: ExecResult) => void;
  /** 以错误终止挂起的 run() */
  rejectRun: (error: Error) => void;
  /** 向 "event" listener 推一帧 exec.output（execId 取首个 runCall） */
  emitExecOutput: (data: string, stream?: string) => void;
  runCalls: ExecRequest[];
  /** stop() 是否被调用过 */
  stopped: () => boolean;
}

/**
 * 可控 fake CoreClient：run() 返回挂起 Promise，由 release()/rejectRun() 驱动；
 * on("event") 注册的 listener 可经 emitExecOutput 推 exec.output 帧。
 * options.stopResolves：true 时 stop() 把挂起的 run 以 exitCode 1 完成（默认 reject）。
 */
export function makeControllableCore(options?: { stopResolves?: boolean }): ControllableCore {
  let runResolve: ((result: ExecResult) => void) | undefined;
  let runReject: ((error: Error) => void) | undefined;
  let eventListener: ((event: CoreEvent) => void) | undefined;
  let stopped = false;
  const emitter = new EventEmitter();
  const runCalls: ExecRequest[] = [];
  const client = makeFakeCore({
    on(eventName: string, listener: (...args: unknown[]) => void) {
      if (eventName === "event") eventListener = listener as (event: CoreEvent) => void;
      emitter.on(eventName, listener);
      return client;
    },
    async stop() {
      stopped = true;
      if (options?.stopResolves && runResolve) {
        runResolve({ exitCode: 1, durationMs: 0, truncated: false } as unknown as ExecResult);
      } else if (runReject) {
        runReject(new Error("Core stopped"));
      }
      runResolve = undefined;
      runReject = undefined;
    },
    async run(request: ExecRequest) {
      runCalls.push({ ...request });
      return new Promise<ExecResult>((resolve, reject) => { runResolve = resolve; runReject = reject; });
    },
  } as Partial<CoreClientLike>);

  return {
    client,
    release: (result: ExecResult) => {
      if (runResolve) { runResolve(result); runResolve = undefined; runReject = undefined; }
    },
    rejectRun: (error: Error) => {
      if (runReject) { runReject(error); runReject = undefined; runResolve = undefined; }
    },
    emitExecOutput: (data: string, stream = "stdout") => {
      if (eventListener) {
        const execId = runCalls[0]?.execId ?? "test";
        eventListener({
          source: "core",
          type: "exec.output",
          payload: { execId, stream, data: Buffer.from(data).toString("base64"), seq: 1 },
        });
      }
    },
    runCalls,
    stopped: () => stopped,
  };
}
