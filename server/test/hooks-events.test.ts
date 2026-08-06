import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { Compactor } from "../src/context/compactor.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import type { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { FastModelClient } from "../src/fast-model.js";
import { HookRunner } from "../src/hooks.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRootRetry, writeProjectHooks } from "./helpers/temp-dir.js";

const tempRoot = (): Promise<string> => tempRootRetry("owc-hooks-events-");

/** 把 hook 的 stdin JSON 负载追加到 marker 文件（条间以 ;;; 分隔）；路径统一正斜杠避免 cmd 转义问题 */
function appendMarkerCommand(file: string): string {
  const target = file.replace(/\\/g, "/");
  return `node -e "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>require('fs').appendFileSync('${target}',d+';;;'))"`;
}

async function readMarkerPayloads(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(file, "utf8");
  return raw.split(";;;").filter((chunk) => chunk.trim()).map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
}

/** 轮询等 marker 文件出现（hook 子进程异步写盘） */
async function waitForMarker(file: string): Promise<Array<Record<string, unknown>>> {
  let payloads: Array<Record<string, unknown>> = [];
  await vi.waitFor(async () => {
    payloads = await readMarkerPayloads(file).catch(() => []);
    expect(payloads.length).toBeGreaterThan(0);
  }, { timeout: 15000 });
  return payloads;
}

function createFakeCore(): CoreClientLike {
  return makeFakeCore({
    async readFile() { return { content: "file content", totalLines: 1, encoding: "utf-8" as const, truncated: false }; },
  });
}

/**
 * e2e 基座：首轮固定调用指定工具，看到其 tool_result 后输出文本收尾；
 * 子代理会话（系统提示含 "sub-agent"）直接收尾不调用工具。
 */
async function setupAgent(root: string, toolCall: { id: string; name: string; input: Record<string, unknown> }) {
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const provider: Provider = {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      if (typeof request.system === "string" && request.system.includes("spawned by OpenWebCode")) {
        yield { type: "text_delta", text: "子代理结论" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      const answered = request.messages.some((message) => message.content.some((block) => block.type === "tool_result" && block.toolCallId === toolCall.id));
      if (!answered) {
        yield { type: "tool_call", id: toolCall.id, name: toolCall.name, input: toolCall.input };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const core = createFakeCore();
  const hooks = new HookRunner(path.join(root, "nonexistent-global.json"), events);
  const agent = new AgentRunner(
    sessions, providers, core, events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    hooks,
  );
  return { sessions, session, events, core, pricing, providers, hooks, agent };
}

describe("Notification 钩子触发点", () => {
  it("权限待批（permission.request）：payload 带 kind=permission、工具名与摘要", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "notification.jsonl");
    await writeProjectHooks(root, { Notification: [{ matcher: "*", command: appendMarkerCommand(marker) }] });
    const { agent, session } = await setupAgent(root, { id: "wf-1", name: "write_file", input: { path: "a.txt", content: "x" } });
    const run = agent.run(session.id, "写文件");
    const payloads = await waitForMarker(marker);
    expect(payloads[0]).toMatchObject({
      sessionId: session.id,
      tool: "write_file",
      notification: { kind: "permission" },
    });
    expect((payloads[0]!.notification as { summary: string }).summary).toContain("write_file");
    expect((payloads[0]!.notification as { summary: string }).summary).toContain("a.txt");
    // 放行挂起的权限请求让 run 收尾。Notification 钩子落盘与权限入队无顺序保证：
    // 高负载 CI 上标记可能先到，需轮询等待 pending 出现（Windows runner 竞态实测复现）
    const pending = await vi.waitFor(() => {
      const item = agent.listPendingPermissions(session.id)[0];
      expect(item).toBeDefined();
      return item!;
    }, { timeout: 5000 });
    const complete = await agent.preparePermissionResponse(session.id, pending.requestId, "deny");
    complete?.();
    await run;
  });

  it("ask_user 待答（interaction.requested）：payload 带 kind=interaction 与标题，无 tool", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "notification.jsonl");
    await writeProjectHooks(root, { Notification: [{ matcher: "*", command: appendMarkerCommand(marker) }] });
    const { agent, session } = await setupAgent(root, { id: "ask-1", name: "ask_user", input: { questions: [{ question: "继续执行吗？", type: "confirm" }] } });
    const run = agent.run(session.id, "先问我");
    const payloads = await waitForMarker(marker);
    expect(payloads[0]).toMatchObject({
      sessionId: session.id,
      notification: { kind: "interaction", summary: "继续执行吗？" },
    });
    expect(payloads[0]!.tool).toBeUndefined();
    const pending = (await agent.listInteractions(session.id)).find((item) => item.status === "pending")!;
    await agent.respondInteraction(session.id, pending.id, true);
    await run;
  });
});

describe("SubagentStart/SubagentStop 钩子触发点", () => {
  it("spawn_task：Start 带 taskId/kind/prompt 摘要，Stop 带同一 taskId 与终态 done", async () => {
    const root = await tempRoot();
    const startMarker = path.join(root, "sub-start.jsonl");
    const stopMarker = path.join(root, "sub-stop.jsonl");
    await writeProjectHooks(root, {
      SubagentStart: [{ matcher: "*", command: appendMarkerCommand(startMarker) }],
      SubagentStop: [{ matcher: "*", command: appendMarkerCommand(stopMarker) }],
    });
    const { agent, session } = await setupAgent(root, { id: "spawn-1", name: "spawn_task", input: { prompt: "探查目录结构" } });
    await agent.run(session.id, "派一个子代理");
    const starts = await readMarkerPayloads(startMarker);
    const stops = await readMarkerPayloads(stopMarker);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ sessionId: session.id });
    // 默认 explore 内置类型：kind=explore；agent 名缺省（resolved.name 为空）不出现在 payload
    expect(starts[0]!.subagent).toMatchObject({ kind: "explore" });
    expect(starts[0]!.prompt).toContain("探查目录结构");
    const taskId = (starts[0]!.subagent as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();
    expect(stops).toHaveLength(1);
    expect(stops[0]!.subagent).toMatchObject({ taskId, status: "done" });
  });

  it("spawn_swarm：每个成员各触发一次 Start/Stop，payload 带 swarm 位置", async () => {
    const root = await tempRoot();
    const startMarker = path.join(root, "swarm-start.jsonl");
    const stopMarker = path.join(root, "swarm-stop.jsonl");
    await writeProjectHooks(root, {
      SubagentStart: [{ matcher: "*", command: appendMarkerCommand(startMarker) }],
      SubagentStop: [{ matcher: "*", command: appendMarkerCommand(stopMarker) }],
    });
    const { agent, session, sessions } = await setupAgent(root, {
      id: "swarm-1",
      name: "spawn_swarm",
      input: { prompt_template: "处理 {{item}}", items: ["甲", "乙"] },
    });
    // spawn_swarm 是按会话开关的工具（session.swarmEnabled）
    await sessions.updateConfig(session.id, { provider: "fake", model: "model", swarmEnabled: true });
    await agent.run(session.id, "并发处理");
    const starts = await readMarkerPayloads(startMarker);
    const stops = await readMarkerPayloads(stopMarker);
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    const positions = starts.map((payload) => (payload.subagent as { swarm: { index: number; total: number } }).swarm.index).sort();
    expect(positions).toEqual([1, 2]);
    for (const payload of starts) {
      expect((payload.subagent as { swarm: { total: number } }).swarm.total).toBe(2);
    }
    for (const payload of stops) {
      expect(payload.subagent).toMatchObject({ status: "done" });
    }
    // Start/Stop 的 taskId 一一对应
    const startIds = starts.map((payload) => (payload.subagent as { taskId: string }).taskId).sort();
    const stopIds = stops.map((payload) => (payload.subagent as { taskId: string }).taskId).sort();
    expect(stopIds).toEqual(startIds);
  });
});

describe("PreCompact/PostCompact 钩子触发点", () => {
  function fakeFastModel(text: string, calls: Array<{ system: string; prompt: string }>): FastModelClient {
    return {
      configured: true,
      provider: "fast-provider",
      model: "fake-cheap-model",
      setConfig() { /* noop */ },
      async complete(input: { system: string; prompt: string }) {
        calls.push(input);
        return { text, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    } as unknown as FastModelClient;
  }

  async function setupCompactor(root: string, fastModel: FastModelClient) {
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", title: "压缩样例" });
    for (let index = 0; index < 15; index += 1) {
      await sessions.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    const hooks = new HookRunner(path.join(root, "nonexistent-global.json"), new EventBus());
    const compactor = new Compactor(sessions, fastModel, { hooks }, 10);
    return { sessions, session, compactor };
  }

  it("两种策略均触发 Pre/PostCompact，payload 带策略、forced 与结果", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "compact.jsonl");
    await writeProjectHooks(root, {
      PreCompact: [{ matcher: "*", command: appendMarkerCommand(marker) }],
      PostCompact: [{ matcher: "*", command: appendMarkerCommand(marker) }],
    });
    const calls: Array<{ system: string; prompt: string }> = [];
    const { sessions, session, compactor } = await setupCompactor(root, fakeFastModel("目标：\n- 摘要", calls));
    const first = await compactor.compact(session.id, "toolcalls");
    expect(first.changed).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: `追加 ${index + 1}` }]);
    }
    const second = await compactor.compact(session.id, "overview", { forced: true });
    expect(second.changed).toBe(true);
    const payloads = await readMarkerPayloads(marker);
    expect(payloads).toHaveLength(4);
    expect(payloads[0]!.compact).toMatchObject({ strategy: "toolcalls", forced: false });
    expect(payloads[1]!.compact).toMatchObject({ strategy: "toolcalls", forced: false, changed: true, finalMode: "toolcalls" });
    expect(payloads[2]!.compact).toMatchObject({ strategy: "overview", forced: true });
    expect(payloads[3]!.compact).toMatchObject({ strategy: "overview", forced: true, changed: true, finalMode: "overview" });
    expect(payloads[0]!.sessionId).toBe(session.id);
  });

  it("PreCompact exit 2 阻断压缩：changed:false 且不调用快速模型", async () => {
    const root = await tempRoot();
    await writeProjectHooks(root, {
      PreCompact: [{ matcher: "*", command: `node -e "process.stderr.write('no-compact');process.exit(2)"` }],
    });
    const calls: Array<{ system: string; prompt: string }> = [];
    const { session, compactor } = await setupCompactor(root, fakeFastModel("目标：\n- 摘要", calls));
    const result = await compactor.compact(session.id, "toolcalls");
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("no-compact");
    expect(calls).toHaveLength(0);
  });
});

describe("工具形态别名（env-sim）下的钩子 payload", () => {
  it("PreToolUse/PostToolUse 的 tool 为内置名（matcher 按内置名命中），别名经 toolAlias 附带", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "alias.jsonl");
    // matcher 按内置名 bash 配置：payload.tool 若是别名 execute_command 则静默失配（本测试的回归点）
    await writeProjectHooks(root, {
      PreToolUse: [{ matcher: "bash", command: appendMarkerCommand(marker) }],
      PostToolUse: [{ matcher: "bash", command: appendMarkerCommand(marker) }],
    });
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    let answered = false;
    const provider: Provider = {
      name: "fake",
      async *streamChat() {
        if (!answered) {
          answered = true;
          yield { type: "tool_call", id: "alias-1", name: "execute_command", input: { cmd: "echo hi" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = createFakeCore();
    const hooks = new HookRunner(path.join(root, "nonexistent-global.json"), events);
    // env-sim 塑形 stub：bash 以别名 execute_command 下发给模型
    const extensions = {
      registeredTools: () => [],
      isEnabled: () => false,
      async beforeTool(input: unknown) { return input; },
      async transformContext(input: { messages: unknown }) { return { messages: input.messages }; },
      async beforeSend(input: { messages: unknown }) { return { messages: input.messages }; },
      async transformPrompt() { return {}; },
      async activeEnvSimPersonaPreset() { return null; },
      async activeToolShaping() {
        return { hideBuiltIns: new Set<string>(), aliases: new Map([["execute_command", { from: "bash" }]]) };
      },
    } as unknown as ExtensionManager;
    const agent = new AgentRunner(
      sessions, providers, core, events, pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      hooks,
      extensions,
    );

    await agent.run(session.id, "跑个命令");

    // Pre 与 Post 各一条：均按内置名命中 matcher，payload 附 toolAlias
    const payloads = await readMarkerPayloads(marker);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload).toMatchObject({ sessionId: session.id, tool: "bash", toolAlias: "execute_command" });
    }
  }, 15_000);
});

describe("SessionEnd 钩子触发点", () => {
  it("删除会话路由：删除前触发，payload 带 sessionId", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "session-end.jsonl");
    await writeProjectHooks(root, { SessionEnd: [{ matcher: "*", command: appendMarkerCommand(marker) }] });
    const { sessions, session, events, core, pricing, providers, hooks, agent } = await setupAgent(root, { id: "t-1", name: "bash", input: { cmd: "echo hi" } });
    const app = await buildServer({ core, sessions, agent, events, providers, pricing, hooks });
    try {
      const res = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
      expect(res.statusCode, res.body).toBe(204);
      const payloads = await readMarkerPayloads(marker);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ sessionId: session.id, cwd: session.cwd });
      expect(await sessions.get(session.id)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
