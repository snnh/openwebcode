import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SessionDetail } from "../src/sessions/types.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 立即收尾的 provider（单轮文本），用于只关心注入/落盘的用例。 */
function textProvider(name: string, text = "ok"): Provider {
  return {
    name,
    async *streamChat() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

async function makeRunner(options: { prefix: string; provider: Provider; sessionConfig?: Record<string, unknown>; agentMode?: "plan" | "code" | "goal" }) {
  const root = await tempRoot(options.prefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: options.provider.name, model: "test-model" });
  await sessions.updateConfig(session.id, {
    provider: options.provider.name,
    model: "test-model",
    snapshotMode: "manual",
    ...(options.agentMode ? { agentMode: options.agentMode } : {}),
    ...options.sessionConfig,
  });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(options.provider);
  const events = new EventBus();
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), events, pricing);
  return { root, sessions, session, runner, events };
}

function injectionsOf(detail: SessionDetail | undefined, prefix: string): string[] {
  return (detail?.messages ?? []).filter((message) => message.id.startsWith(prefix)).map((message) => message.id);
}

function toolResultsOf(detail: SessionDetail | undefined): Array<{ toolCallId: string; content: string; isError: boolean }> {
  return (detail?.messages ?? [])
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result")
    .map((block) => ({ toolCallId: block.toolCallId, content: block.content, isError: block.isError === true }));
}

describe("subagent fan-out：每条 tool_call 必须有对应 tool_result", () => {
  it("被可用性检查拦截的调用同样落盘 error 结果（不再静默 continue）", async () => {
    let turn = 0;
    const provider: Provider = {
      name: "fanout",
      async *streamChat() {
        turn += 1;
        if (turn === 1) {
          // 同消息两条子代理调用 → 走 fan-out 并行路径（默认并行数 2）
          yield { type: "tool_call", id: "call-a", name: "spawn_task", input: { prompt: "探索 A", agent: "explore" } };
          yield { type: "tool_call", id: "call-b", name: "spawn_task", input: { prompt: "探索 B", agent: "explore" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    // 工具白名单里没有 subagent → 两条调用都进「不可用」分支
    const { sessions, session, runner } = await makeRunner({
      prefix: "owc-fanout-blocked-",
      provider,
      sessionConfig: { toolsAllow: ["read_file"] },
    });

    await runner.run(session.id, "并行探索");

    const results = toolResultsOf(await sessions.get(session.id));
    expect(results.map((result) => result.toolCallId).sort()).toEqual(["call-a", "call-b"]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toBe("Tool is not available in this turn: spawn_task");
    }
  });
});

describe("plan/goal 注入节奏", () => {
  it("exit 提醒只注入一次（本 run 的 exit 注入不算 lastPlan）", async () => {
    const provider = textProvider("inject");
    const { sessions, session, runner } = await makeRunner({ prefix: "owc-plan-exit-", provider, agentMode: "plan" });

    await runner.run(session.id, "先出实施计划");
    // 批准计划 = 退出 plan 模式（updateConfig 的 agentMode 缺省即删除）
    await sessions.updateConfig(session.id, { provider: provider.name, model: "test-model" });

    await runner.run(session.id, "按计划执行第一步");
    await runner.run(session.id, "继续第二步");

    const detail = await sessions.get(session.id);
    expect(injectionsOf(detail, "inj:plan:full:")).toHaveLength(1);
    expect(injectionsOf(detail, "inj:plan:exit:")).toHaveLength(1);
  });

  it("长运行跨日：轮内日期刷新注入新日期锚点且不重复", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2024-03-01T23:30:00Z"));
      let turn = 0;
      const provider: Provider = {
        name: "date",
        async *streamChat(request) {
          turn += 1;
          if (turn === 1) {
            // 本轮之后（下一次 provider 请求前）跨过午夜
            vi.setSystemTime(new Date("2024-03-02T00:10:00Z"));
            yield { type: "tool_call", id: "t-1", name: "read_file", input: { path: "a.ts" } };
            yield { type: "done", stopReason: "tool_use" };
            return;
          }
          request.signal.throwIfAborted();
          yield { type: "text_delta", text: "跨日完成" };
          yield { type: "done", stopReason: "end_turn" };
        },
      };
      const { root, sessions, session, runner } = await makeRunner({ prefix: "owc-date-refresh-", provider });
      // 昨天的日期锚点已在活动路径上（跨日后的轮内刷新只比对变体，不重复注入同日）
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: "<system-reminder>\nCurrent date: 2024-03-01 (UTC).\n</system-reminder>" }], {
        id: "inj:date:2024-03-01:seed",
        internal: true,
      });

      await runner.run(session.id, "跨日长运行");

      // 断言点必须在第二轮 run 之前：run 启动时的日期刷新（flags.dateRefresh=true）本就会补锚点，
      // 只有轮内刷新真正生效时，第一轮 run 内跨日就能拿到新日期。
      expect(root).toBeTruthy();
      expect(injectionsOf(await sessions.get(session.id), "inj:date:2024-03-02:")).toHaveLength(1);

      await runner.run(session.id, "再跑一轮");
      const detail = await sessions.get(session.id);
      expect(injectionsOf(detail, "inj:date:2024-03-02:")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
