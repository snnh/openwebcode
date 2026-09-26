import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { RunStore, type AgentRunSnapshot } from "../src/agent/run-store.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRoot } from "./helpers/temp-roots.js";
import { waitForEvent } from "./helpers/wait-event.js";

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
  const observed: AppEvent[] = [];
  events.on("event", (event) => observed.push(event));
  return { sessions, session, events, observed, runner: new AgentRunner(sessions, providers, makeFakeCore(), events, pricing) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

describe("计划批准切换 code 模式", () => {
  it("透传 fallbackModels/sshCredentials，不被 updateConfig 的 undefined=清除语义抹掉", async () => {
    let turn = 0;
    const provider: Provider = {
      name: "plan-approval",
      async *streamChat() {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", id: "plan-1", name: "exit_plan_mode", input: { plan: "1. 改 A\n2. 改 B" } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "开始执行" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const { sessions, session, runner, events } = await makeRunner({
      prefix: "owc-plan-approval-",
      provider,
      agentMode: "plan",
      sessionConfig: { fallbackModels: [{ provider: "fallback", model: "fallback-model" }], sshCredentials: true },
    });

    const requested = waitForEvent(events, "interaction.requested", { sessionId: session.id });
    const running = runner.run(session.id, "先出计划，批准后直接执行");
    const interaction = await withTimeout(requested, 5_000, "等待计划批准交互");
    await runner.respondInteraction(session.id, (interaction.payload as { id: string }).id, { decision: "approve" });
    await withTimeout(running, 10_000, "计划批准后的 run");

    const after = await sessions.getMeta(session.id);
    expect(after?.agentMode).toBeUndefined(); // 已退出 plan（code 不落盘）
    expect(after).toMatchObject({ fallbackModels: [{ provider: "fallback", model: "fallback-model" }], sshCredentials: true });
  });
});

describe("finishRun 收尾与新 run 并发", () => {
  it("旧 run 收尾等待落盘期间启动的新 run 状态不被误删", async () => {
    let call = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const provider: Provider = {
      name: "lifecycle",
      async *streamChat() {
        call += 1;
        if (call === 1) {
          yield { type: "text_delta", text: "first" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        await secondGate;
        yield { type: "text_delta", text: "second" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const { sessions, session, runner, observed } = await makeRunner({ prefix: "owc-run-lifecycle-", provider });

    // 拦住宿盘：把旧 run 的 finishRun 卡在 writeRun（此时 running 已放行 → 新 run 可启动）
    const originalWrite = RunStore.prototype.write;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let entered = false;
    let signalEntered!: () => void;
    const enteredFirst = new Promise<void>((resolve) => { signalEntered = resolve; });
    const spy = vi.spyOn(RunStore.prototype, "write").mockImplementation(async function (this: RunStore, run: AgentRunSnapshot) {
      if (run.state === "completed" && !entered) {
        entered = true;
        signalEntered();
        await firstGate;
      }
      return originalWrite.call(this, run);
    });

    try {
      // 白盒读内存快照：run 的 id 只在内存 map 里（REST getRun 会被写链挡住）
      const runs = (runner as unknown as { runs: Map<string, AgentRunSnapshot> }).runs;
      const runA = runner.run(session.id, "第一轮");
      await withTimeout(enteredFirst, 5_000, "旧 run 进入收尾落盘");
      const runAId = runs.get(session.id)?.id;

      const runB = runner.run(session.id, "第二轮");
      await vi.waitFor(() => expect(runs.get(session.id)?.id).not.toBe(runAId));
      const runBId = runs.get(session.id)!.id;

      releaseFirst();
      await withTimeout(runA, 10_000, "旧 run 收尾");
      // 关键不变量：旧 run 收尾不得删掉新 run 的内存快照
      expect(runs.get(session.id)?.id).toBe(runBId);

      releaseSecond();
      await withTimeout(runB, 10_000, "新 run 收尾");
      expect(runs.has(session.id)).toBe(false); // 新 run 自己正常收尾清空
      expect(observed.some((event) => event.type === "run.completed" && (event.payload as { id?: string }).id === runBId)).toBe(true);
      expect((await sessions.get(session.id))?.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === "second"))).toBe(true);
    } finally {
      spy.mockRestore();
      releaseFirst();
      releaseSecond();
    }
  }, 30_000);
});
