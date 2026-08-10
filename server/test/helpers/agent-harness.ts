import path from "node:path";
import { expect, vi } from "vitest";
import { AgentRunner } from "../../src/agent/agent-runner.js";
import { buildServer } from "../../src/app.js";
import type { CoreClientLike } from "../../src/core-client.js";
import { PricingCatalog } from "../../src/cost/pricing-catalog.js";
import { EventBus } from "../../src/events/event-bus.js";
import type { Provider } from "../../src/providers/provider.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import type { SessionStore } from "../../src/sessions/session-store.js";
import { SessionStore as SessionStoreImpl } from "../../src/sessions/session-store.js";
import { makeFakeCore } from "./fake-core.js";
import { makeStubProvider } from "./stub-provider.js";
import { tempRoot } from "./temp-roots.js";

export interface AgentHarnessOptions {
  /** 默认：test-stub，直接 done */
  provider?: Provider;
  /** 默认：makeFakeCore() 空实现 */
  core?: CoreClientLike;
  title?: string;
  model?: string;
  permissionMode?: Parameters<SessionStore["updatePermissions"]>[1];
  agentMode?: "plan" | "code" | "goal";
  /** 额外 updateConfig 字段（如 reviewModel / effort） */
  sessionConfig?: Record<string, unknown>;
  tempPrefix?: string;
}

/**
 * 标准 agent 测试装配：临时目录 + SessionStore + PricingCatalog + EventBus +
 * ProviderRegistry + AgentRunner + buildServer。
 * 各测试文件按需在返回值上再挂 events.on / agent.setFastModel 等。
 */
export async function makeAgentHarness(options: AgentHarnessOptions = {}) {
  const root = await tempRoot(options.tempPrefix ?? "owc-harness-");
  const sessions = new SessionStoreImpl(path.join(root, "sessions"));
  await sessions.initialize();
  const provider = options.provider ?? makeStubProvider("test-stub", async function* () {
    yield { type: "done", stopReason: "end_turn" };
  });
  const model = options.model ?? "deterministic-tool-loop";
  const session = await sessions.create({ cwd: root, provider: provider.name, model, title: options.title ?? "Test" });
  if (options.agentMode || options.sessionConfig) {
    await sessions.updateConfig(session.id, { provider: provider.name, model, ...options.sessionConfig, ...(options.agentMode ? { agentMode: options.agentMode } : {}) });
  }
  if (options.permissionMode) await sessions.updatePermissions(session.id, options.permissionMode, []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = options.core ?? makeFakeCore();
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, pricing, events, providers, provider, core, agent, app };
}

/**
 * 挂起直到 abort 再 throw 的 provider：模拟真实 provider 响应 abort 信号。
 * 返回的 entered Promise 在 provider 进入挂起点时解决（此时 abort 才会被挂起请求感知）。
 */
export function makeAbortPendingProvider(name = "test-stub"): { provider: Provider; entered: Promise<void> } {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const provider: Provider = {
    name,
    async *streamChat(request) {
      markEntered();
      // 模拟真实 provider 响应 abort：在信号触发前一直挂起
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted");
    },
  };
  return { provider, entered };
}

/** 等到会话出现 pending 交互并返回之。15s：Windows CI/本地全量并行高负载下 5s 会抖动超时。 */
export async function waitForPendingInteraction(agent: AgentRunner, sessionId: string) {
  await vi.waitFor(async () => {
    const list = await agent.listInteractions(sessionId);
    expect(list.some((item) => item.status === "pending")).toBe(true);
  }, { timeout: 15000 });
  return (await agent.listInteractions(sessionId)).find((item) => item.status === "pending")!;
}

/** 在会话详情里找指定 toolCallId 的 tool_result 块 */
export function toolResultOf(detail: Awaited<ReturnType<SessionStore["get"]>>, toolCallId: string) {
  return detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.toolCallId === toolCallId);
}

/** 等到 sessions 落盘出现至少 count 条 role=tool 消息 */
export async function waitForToolMessage(sessions: SessionStore, id: string, count = 1): Promise<void> {
  await vi.waitFor(async () => {
    const detail = await sessions.get(id);
    const n = detail?.messages.filter((m) => m.role === "tool").length ?? 0;
    if (n < count) throw new Error("no tool message yet");
  }, { timeout: 5_000 });
}
