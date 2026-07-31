import type { CoreClientLike } from "../../src/core-client.js";

/** 假 core：job 输出一次性返回给定文本，状态 completed。 */
export function makeJobReplayCore(output: string, options: { exitCode?: number; durationMs?: number } = {}): CoreClientLike {
  const { exitCode = 0, durationMs = 7 } = options;
  let served = false;
  const core = {
    on() { return core; },
    async startJob() { served = false; return { jobId: "j", state: "running" as const }; },
    async jobStatus() { return { jobId: "j", state: "completed" as const, exitCode, durationMs }; },
    async jobOutput(request: { afterSeq: number }) {
      if (request.afterSeq === 0 && !served) {
        served = true;
        return { chunks: [{ seq: 1, stream: "stdout" as const, data: output }], nextSeq: 2, truncated: false };
      }
      return { chunks: [], nextSeq: request.afterSeq, truncated: false };
    },
    async cancelJob(request: { jobId: string }) { return { jobId: request.jobId, accepted: true as const }; },
  } as unknown as CoreClientLike;
  return core;
}
