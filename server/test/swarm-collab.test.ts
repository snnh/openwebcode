import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ModelRoleResolver } from "../src/model-roles.js";
import { ProviderRegistry, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { encodeFastModelSelection, SettingsService } from "../src/settings-service.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/**
 * spawn_swarm 协作链路集成测试：roster/生命周期帖、started payload role/model、
 * 成员板工具（post/wait）、synthesize 合成轮（on/off/失败回落）。
 */

interface SwarmFixture {
  runner: AgentRunner;
  sessionId: string;
  sessions: SessionStore;
  root: string;
  requests: Map<string, StreamChatRequest[]>;
  captured: AppEvent[];
}

interface MemberScriptOptions {
  /** 成员轮次脚本：post 一帖 + wait 一秒超时后收尾（默认直接回结论）。 */
  useBoardTools?: boolean;
  /** 合成轮请求（system 含 synthesizer）抛错，验证失败回落。 */
  synthesisFails?: boolean;
}

async function setupSwarm(options: {
  env?: NodeJS.ProcessEnv;
  spawnInput: Record<string, unknown>;
  member?: MemberScriptOptions;
}): Promise<SwarmFixture> {
  const root = await tempRoot("owc-swarm-collab-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "main", model: "main-model" });
  await sessions.updateConfig(session.id, { provider: "main", model: "main-model", swarmEnabled: true });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const captured: AppEvent[] = [];
  events.on("event", (event: AppEvent) => captured.push(event));
  const usageLog = new UsageLog(root);
  const requests = new Map<string, StreamChatRequest[]>();
  const record = (name: string, request: StreamChatRequest): void => {
    requests.set(name, [...(requests.get(name) ?? []), request]);
  };

  // 注意：主循环系统提示含 "Sub-agent model roles"，不能用 "sub-agent" 粗匹配区分成员请求
  const isSynthesis = (request: StreamChatRequest): boolean => request.system.includes("synthesizer of a parallel sub-agent swarm");
  const isMember = (request: StreamChatRequest): boolean => request.system.includes("exploration sub-agent") && !isSynthesis(request);

  let mainTurn = 0;
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("main", async function* (request) {
    record("main", request);
    if (isSynthesis(request)) {
      if (options.member?.synthesisFails) throw new Error("synthesis boom");
      yield { type: "text_delta", text: "合成报告正文" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (isMember(request)) {
      yield* memberScript(request, options.member);
      return;
    }
    if (mainTurn++ === 0) {
      yield { type: "tool_call", id: "spawn-1", name: "spawn_swarm", input: options.spawnInput };
      yield { type: "done", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", text: "完成" };
      yield { type: "done", stopReason: "end_turn" };
    }
  }));
  providers.register(makeStubProvider("cheap-provider", async function* (request) {
    record("cheap-provider", request);
    if (isSynthesis(request)) {
      if (options.member?.synthesisFails) throw new Error("synthesis boom");
      yield { type: "text_delta", text: "合成报告正文" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    yield* memberScript(request, options.member);
  }));
  const settings = await SettingsService.load({ env: options.env ?? {}, filePath: path.join(root, "server-settings.json") });
  const runner = new AgentRunner(
    sessions, providers, makeFakeCore(), events, pricing,
    undefined, "zh-CN", 50, undefined, usageLog,
    undefined, undefined, undefined, undefined, undefined,
  );
  runner.setModelRoleResolver(new ModelRoleResolver(settings, providers));
  return { runner, sessionId: session.id, sessions, root, requests, captured };
}

/** 成员轮次脚本：默认直接回结论；useBoardTools 时先 post 一帖、再 wait 一秒超时、最后收尾。 */
async function* memberScript(request: StreamChatRequest, options?: MemberScriptOptions): AsyncIterable<import("../src/providers/provider.js").ProviderEvent> {
  if (!options?.useBoardTools) {
    yield { type: "text_delta", text: "成员结论" };
    yield { type: "done", stopReason: "end_turn" };
    return;
  }
  const toolResults = request.messages.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  const posted = toolResults.some((block) => block.type === "tool_result" && block.content === "ok");
  const waited = toolResults.some((block) => block.type === "tool_result" && block.content.includes("(timeout)"));
  if (!posted) {
    yield { type: "tool_call", id: `post-${request.messages.length}`, name: "swarm_board_post", input: { text: "发现X", kind: "finding", priority: "high" } };
    yield { type: "done", stopReason: "tool_use" };
    return;
  }
  if (!waited) {
    yield { type: "tool_call", id: `wait-${request.messages.length}`, name: "swarm_wait", input: { any: true, timeoutSeconds: 1 } };
    yield { type: "done", stopReason: "tool_use" };
    return;
  }
  yield { type: "text_delta", text: "成员结论" };
  yield { type: "done", stopReason: "end_turn" };
}

/** 读本次 swarm 的板文件（swarmId = toolCallId "spawn-1"）。 */
async function readBoard(fixture: SwarmFixture): Promise<Array<Record<string, unknown>>> {
  const boardPath = path.join(fixture.sessions.contextRoot(fixture.sessionId), "subagents", "swarm-spawn-1-board.jsonl");
  const raw = await readFile(boardPath, "utf8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 主循环 tool_result（spawn-1）的内容与逐state。 */
async function spawnResult(fixture: SwarmFixture): Promise<{ content: string; isError: boolean; subagentTasks?: Array<Record<string, unknown>> }> {
  const detail = await fixture.sessions.get(fixture.sessionId);
  const block = detail?.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .find((entry) => entry.type === "tool_result" && entry.toolCallId === "spawn-1");
  if (!block || block.type !== "tool_result") throw new Error("spawn tool_result not found");
  return block as { content: string; isError: boolean; subagentTasks?: Array<Record<string, unknown>> };
}

describe("spawn_swarm roster 与生命周期", () => {
  it("启动前写 roster 系统贴（含 taskExcerpt/去重成员名），成员起止写 lifecycle 帖；synthesize 缺省不触发", async () => {
    const fixture = await setupSwarm({
      spawnInput: { prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    const board = await readBoard(fixture);
    const roster = board.find((line) => line.kind === "roster");
    expect(roster).toBeDefined();
    // 默认 explore 类型两项重名 → 后缀去重
    const members = roster?.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.member)).toEqual(["explore", "explore-2"]);
    expect(members[0]).toMatchObject({ index: 1, agent: "explore", model: "main-model", taskExcerpt: "审查 a.ts" });
    expect(members[1]).toMatchObject({ index: 2, taskExcerpt: "审查 b.ts" });

    const lifecycle = board.filter((line) => line.kind === "lifecycle");
    // 两成员各 started + finished
    expect(lifecycle).toHaveLength(4);
    expect(lifecycle.filter((line) => line.event === "started").map((line) => line.member).sort()).toEqual(["explore", "explore-2"]);
    expect(lifecycle.filter((line) => line.event === "finished")).toHaveLength(2);

    // synthesize 缺省关闭：无合成事件
    expect(fixture.captured.filter((event) => event.type === "subagent.synthesis")).toHaveLength(0);
  });
});

describe("spawn_swarm started payload 与逐项终态", () => {
  it("started 事件与 subagentTasks 携带 role/model", async () => {
    const fixture = await setupSwarm({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("cheap-provider", "cheap-model") },
      spawnInput: { prompt_template: "评审 {{item}}", items: ["a.ts", { task: "b.ts", role: "cheap" }], role: "balanced" },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    const started = fixture.captured.filter((event) => event.type === "subagent.started");
    expect(started).toHaveLength(2);
    // 第一项用调用级 balanced（未配置 → 回落会话模型，role 字段仍标注请求档）；第二项逐项 cheap
    expect(started[0]?.payload).toMatchObject({ role: "balanced", model: "main-model" });
    expect(started[1]?.payload).toMatchObject({ role: "cheap", model: "cheap-model" });

    const result = await spawnResult(fixture);
    expect(result.isError).toBe(false);
    expect(result.subagentTasks).toHaveLength(2);
    expect(result.subagentTasks?.[0]).toMatchObject({ index: 0, status: "done", role: "balanced", model: "main-model" });
    expect(result.subagentTasks?.[1]).toMatchObject({ index: 1, status: "done", role: "cheap", model: "cheap-model" });
  });
});

describe("spawn_swarm 成员板工具", () => {
  it("成员 post 落板进 digest（kind/priority 保留），swarm_wait 超时正常收尾", async () => {
    const fixture = await setupSwarm({
      spawnInput: { prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] },
      member: { useBoardTools: true },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    const board = await readBoard(fixture);
    const posts = board.filter((line) => line.kind === "finding");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ text: "发现X", priority: "high" });
    expect(posts.map((line) => line.from).sort()).toEqual(["explore", "explore-2"]);

    const result = await spawnResult(fixture);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Board digest");
    expect(result.content).toContain("by kind: finding=2");
  }, 20000);
});

describe("spawn_swarm synthesize 合成轮", () => {
  it("开启后做一次无工具合成调用：事件 started/finished，报告排在成员结论之前", async () => {
    const fixture = await setupSwarm({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("cheap-provider", "cheap-model") },
      spawnInput: { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "cheap" } },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    // 合成请求落在角色 provider：无工具、单条用户消息含成员结论
    const synthRequests = (fixture.requests.get("cheap-provider") ?? []).filter((request) => request.system.includes("synthesizer"));
    expect(synthRequests).toHaveLength(1);
    expect(synthRequests[0]?.tools).toEqual([]);
    expect(synthRequests[0]?.model).toBe("cheap-model");
    const synthInput = synthRequests[0]?.messages[0]?.content[0];
    expect(synthInput?.type === "text" && synthInput.text).toContain("Member conclusions");

    const events = fixture.captured.filter((event) => event.type === "subagent.synthesis");
    expect(events.map((event) => (event.payload as Record<string, unknown>).phase)).toEqual(["started", "finished"]);
    expect(events[1]?.payload).toMatchObject({ status: "done", model: "cheap-model" });

    const result = await spawnResult(fixture);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Synthesis (cheap → cheap-provider/cheap-model):\n合成报告正文");
    expect(result.content).toContain("Member conclusions");
    // 合成报告在前，成员结论在后
    expect(result.content.indexOf("Synthesis")).toBeLessThan(result.content.indexOf("Member conclusions"));
  });

  it("合成失败回落纯拼接并标注错误， swarm 结果不丢", async () => {
    const fixture = await setupSwarm({
      env: { OWC_ROLE_MODEL_CHEAP: encodeFastModelSelection("cheap-provider", "cheap-model") },
      spawnInput: { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "cheap" } },
      member: { synthesisFails: true },
    });
    await fixture.runner.run(fixture.sessionId, "派单");

    const events = fixture.captured.filter((event) => event.type === "subagent.synthesis");
    expect(events[1]?.payload).toMatchObject({ phase: "finished", status: "failed", error: expect.stringContaining("synthesis boom") });

    const result = await spawnResult(fixture);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Synthesis failed (cheap");
    expect(result.content).toContain("synthesis boom");
    expect(result.content).toContain("成员结论");
  });

  it("非法 role 在启动前拒绝整次调用", async () => {
    const fixture = await setupSwarm({
      spawnInput: { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "bogus" } },
    });
    await fixture.runner.run(fixture.sessionId, "派单");
    const result = await spawnResult(fixture);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown model role: bogus");
  });
});
