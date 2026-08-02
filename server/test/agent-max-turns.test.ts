import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 每轮都发起工具调用的 provider：主循环无法自然收尾，只能撞轮次上限。 */
function loopingProvider(name: string): Provider {
  let counter = 0;
  return {
    name,
    async *streamChat() {
      counter += 1;
      yield { type: "tool_call", id: `loop-${counter}`, name: "todo_write", input: { items: [{ content: `轮次 ${counter}`, status: "pending" }] } };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "tool_use" };
    },
  };
}

async function setup(maxTurns?: number): Promise<{ runner: AgentRunner; sessionId: string }> {
  const root = await tempRoot("owc-agent-max-turns-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "loop", model: "test-model" });
  // yolo 跳过权限确认；manual 排除快照后端干扰
  await sessions.updateConfig(session.id, { provider: "loop", model: "test-model", snapshotMode: "manual", permissionMode: "yolo" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(loopingProvider("loop"));
  const runner = new AgentRunner(
    sessions,
    providers,
    makeFakeCore(),
    new EventBus(),
    pricing,
    undefined,
    "zh-CN",
    ...(maxTurns !== undefined ? [maxTurns] as const : []),
  );
  return { runner, sessionId: session.id };
}

describe("AgentRunner 轮次上限（设置页 agentMaxTurns 热生效）", () => {
  it("默认 50 轮：循环 provider 以 Agent exceeded 50 turns 收尾", async () => {
    const { runner, sessionId } = await setup();
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 50 turns");
  }, 30_000);

  it("构造参数可压低上限：maxTurns=2 → Agent exceeded 2 turns", async () => {
    const { runner, sessionId } = await setup(2);
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 2 turns");
  }, 30_000);

  it("setMaxTurns 注入的取值函数覆盖构造参数（设置热生效路径）", async () => {
    const { runner, sessionId } = await setup(50);
    let current = 3;
    runner.setMaxTurns(() => current);
    await expect(runner.run(sessionId, "跑个长任务")).rejects.toThrow("Agent exceeded 3 turns");
    // 取值函数实时生效：调大后下一次运行按新上限收尾
    current = 5;
    await expect(runner.run(sessionId, "继续跑")).rejects.toThrow("Agent exceeded 5 turns");
  }, 30_000);
});
