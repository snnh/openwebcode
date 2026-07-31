import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeControllableCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

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
  const root = await tempRoot("owc-tool-summary-");
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
  // jobControl: false → 走非 jobControl 的 core.run 路径（本文件要覆盖的路径）
  const core = makeControllableCore();
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
    core.emitExecOutput(bigOutput);
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
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
    core.emitExecOutput("hello world");
    core.release({ exitCode: 0, durationMs: 1, truncated: false });
    await runPromise;

    const toolEnd = published.find((event) => event.type === "tool.end");
    const payload = toolEnd!.payload as { result: Record<string, unknown> };
    expect(payload.result.truncated).toBe(false);
    expect(payload.result.artifactId).toBeUndefined();
    expect(payload.result.preview as string).toContain("hello world");
  }, 15_000);
});
