import type { CoreClientLike, FsScanResult, FsStatResult } from "../../src/core-client.js";

interface FakeScanState {
  mtime: number;
  scanCalls: number;
}

/**
 * 虚拟工作区 fake core：scanFiles 由给定路径清单分页返回（目录条目从文件路径推导），
 * statFile 的 mtime 经 state 可控，scanCalls 记录扫描次数。
 */
export function makeFakeScanCore(files: string[], state: FakeScanState = { mtime: 1, scanCalls: 0 }): CoreClientLike {
  const entries = [
    ...files.map((p) => ({ path: p, type: "file" as const, size: p.length })),
    // 目录条目（从文件路径推导）
    ...[...new Set(files.flatMap((p) => {
      const parts = p.split("/");
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    }))].map((p) => ({ path: p, type: "directory" as const, size: 0 })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    on() { return this; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
    async cleanupSession() { return { ok: true }; },
    setRequestTimeoutMs() { /* no-op */ },
    start() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    stop() { return Promise.resolve(); },
    ping() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
    async statFile(): Promise<FsStatResult> { return { type: "directory", size: 0, modifiedMs: state.mtime }; },
    async scanFiles(request: { cursor?: number; limit?: number }): Promise<FsScanResult> {
      state.scanCalls += 1;
      const start = request.cursor ?? 0;
      const limit = request.limit ?? 1000;
      const page = entries.slice(start, start + limit);
      const next = start + limit < entries.length ? start + limit : undefined;
      return { entries: page, truncated: false, ...(next === undefined ? {} : { nextCursor: next }) };
    },
  } as unknown as CoreClientLike;
}
