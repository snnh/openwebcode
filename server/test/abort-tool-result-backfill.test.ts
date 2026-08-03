import { describe, expect, it, vi } from "vitest";
import type { CoreClientLike, JobStatus } from "../src/core-client.js";
import type { Provider } from "../src/providers/provider.js";
import { makeAgentHarness, toolResultOf } from "./helpers/agent-harness.js";
import { FAKE_CORE_INFO, makeFakeCore } from "./helpers/fake-core.js";

/** jobControl 挂起 job 的 fake core：job 一直 running，cancelJob 后转为 cancelled（复刻真实中断链路）。 */
function makeHangingJobCore(): { core: CoreClientLike; started: () => number } {
  let cancelled = false;
  let started = 0;
  const status = (): JobStatus => cancelled
    ? { jobId: "job-1", state: "cancelled", error: "Job cancelled" }
    : { jobId: "job-1", state: "running" };
  const core = makeFakeCore({
    async start() { return { ...FAKE_CORE_INFO, features: { ...FAKE_CORE_INFO.features, jobControl: true } }; },
    async ping() { return { ...FAKE_CORE_INFO, features: { ...FAKE_CORE_INFO.features, jobControl: true } }; },
    async startJob() { started++; return status(); },
    async jobStatus() { return status(); },
    async jobOutput() { return { chunks: [], nextSeq: 0, truncated: false }; },
    async cancelJob() { cancelled = true; return { jobId: "job-1", accepted: true as const }; },
  });
  return { core, started: () => started };
}

describe("中断后 tool_result 补写", () => {
  it("挂起的 bash 被中断：已落盘 tool_call 补写错误 tool_result，历史保持配对", async () => {
    const { core, started } = makeHangingJobCore();
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        yield { type: "tool_call", id: "hang-1", name: "bash", input: { cmd: "sleep 600" } };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const harness = await makeAgentHarness({ provider, core, model: "model", permissionMode: "yolo", tempPrefix: "owc-abort-backfill-" });
    try {
      const run = harness.agent.run(harness.session.id, "跑个长任务");
      // 等 bash 真正进入 core job（assistant 的 tool_call 已落盘、工具在途）
      await vi.waitFor(() => expect(started()).toBe(1), { timeout: 5000 });
      expect(harness.agent.abort(harness.session.id)).toBe(true);
      // abort 路径 run() 会 rethrow（agent.aborted 语义）
      await run.then(() => undefined, () => undefined);
      const detail = await harness.sessions.get(harness.session.id);
      const result = toolResultOf(detail, "hang-1");
      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect((result as { content: string }).content).toContain("interrupted");
    } finally {
      await harness.app.close();
    }
  });
});
