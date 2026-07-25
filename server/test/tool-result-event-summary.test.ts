import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike, CoreEvent, ExecRequest, ExecResult } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/**
 * 可控 core stub：run 挂起，等待测试驱动 exec.output / 完成。
 * 不走 jobControl 分支（capabilities 为空），覆盖 executeBash 的非 jobControl 路径。
 */
function createControllableCore() {
  const emitter = new EventEmitter();
  let eventListener: ((event: CoreEvent) => void) | undefined;
  let runResolve: ((result: ExecResult) => void) | undefined;
  const runCalls: ExecRequest[] = [];
  const client = {
    on(eventName: string, listener: (...args: unknown[]) => void) {
      if (eventName === "event") eventListener = listener as (event: CoreEvent) => void;
      emitter.on(eventName, listener);
      return client;
    },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async run(request: ExecRequest) {
      runCalls.push({ ...request });
      return new Promise<ExecResult>((resolve) => { runResolve = resolve; });
    },
    // jobControl: false → 走非 jobControl 的 core.run 路径（本轮要覆盖的路径）
    async ping() {
      return {
        version: "0.2.4-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory" as const,
        features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
        limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
      };
    },
    async cleanupSession() { return { ok: true as const }; },
    async readFile() { return { content: "", totalLines: 0, encoding: "utf-8" as const, truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 0 }; },
    async listFiles() { return { entries: [], truncated: false }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    setRequestTimeoutMs() {},
  } as unknown as CoreClientLike;
  return {
    client,
    runCalls,
    emitOutput(data: string) {
      eventListener?.({
        source: "core",
        type: "exec.output",
        payload: { execId: runCalls[0]?.execId ?? "test", stream: "stdout", data: Buffer.from(data).toString("base64"), seq: 1 },
      });
    },
    finish(result: ExecResult = { exitCode: 0, durationMs: 1, truncated: false }) { runResolve?.(result); },
  };
}

/** 首轮发起一次 bash 工具调用，次轮结束 turn。 */
function makeBashProvider(): Provider {
  let turn = 0;
  return {
    name: "tool-summary-stub",
    async *streamChat() {
      if (turn++ === 0) {
        yield { type: "tool_call", id: "bash-1", name: "bash", input: { cmd: "echo hi" } };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-tool-summary-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "tool-summary-stub", model: "claude-opus-4-8" });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const published: AppEvent[] = [];
  events.on("event", (event: AppEvent) => published.push(event));
  const providers = new ProviderRegistry();
  providers.register(makeBashProvider());
  const core = createControllableCore();
  const runner = new AgentRunner(sessions, providers, core.client, events, pricing);
  return { root, sessions, session, events, published, core, runner };
}

describe("工具结果事件只发摘要 + artifact 引用（enforcement）", () => {
  it("大工具结果：WS 事件载荷只有 ≤1KB preview + artifactId，全文落 artifact", async () => {
    const { sessions, session, published, core, runner } = await setup();
    // ~200KB 输出（约 5 万 tokens，远超 bash 8000 token 预算）
    const marker = "FULL-OUTPUT-MARKER-";
    const bigOutput = marker + "x".repeat(200_000);

    const runPromise = runner.run(session.id, "run it");
    await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
    core.emitOutput(bigOutput);
    core.finish();
    await runPromise;

    const toolEnd = published.find((event) => event.type === "tool.end");
    expect(toolEnd).toBeDefined();
    const payload = toolEnd!.payload as { toolCallId: string; result: Record<string, unknown> };
    expect(payload.toolCallId).toBe("bash-1");
    // 事件载荷是摘要形态：preview + originalTokens + truncated + artifactId，不含 result 全文
    expect(payload.result.truncated).toBe(true);
    expect(typeof payload.result.artifactId).toBe("string");
    expect((payload.result.preview as string).length).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(payload).length).toBeLessThan(8_000);
    expect(JSON.stringify(payload)).not.toContain(bigOutput.slice(0, 4096));

    // 全文走 artifact 读取路径：artifact 文件内容完整
    const artifactPath = path.join(sessions.contextRoot(session.id), "artifacts", `${payload.result.artifactId as string}.txt`);
    const artifactText = await readFile(artifactPath, "utf8");
    expect(artifactText).toContain(marker);
    expect(artifactText.length).toBeGreaterThan(200_000);
  }, 15_000);

  it("小工具结果：preview 即全文、无 artifactId、不截断", async () => {
    const { session, published, core, runner } = await setup();
    const runPromise = runner.run(session.id, "run it");
    await vi.waitFor(() => expect(core.runCalls.length).toBe(1), { timeout: 10_000 });
    core.emitOutput("hello world");
    core.finish();
    await runPromise;

    const toolEnd = published.find((event) => event.type === "tool.end");
    const payload = toolEnd!.payload as { result: Record<string, unknown> };
    expect(payload.result.truncated).toBe(false);
    expect(payload.result.artifactId).toBeUndefined();
    expect(payload.result.preview as string).toContain("hello world");
  }, 15_000);
});
