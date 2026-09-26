import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ModelRoleResolver } from "../src/model-roles.js";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { encodeFastModelSelection, SettingsService } from "../src/settings-service.js";
import { UsageLog } from "../src/usage-log.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** spawn_swarm 协作链路：roster/生命周期、started payload role/model、板工具、synthesize 合成轮。 */

const CHEAP = encodeFastModelSelection("cheap-provider", "cheap-model");
type Fixture = Awaited<ReturnType<typeof setupSwarm>>;
type SetupOptions = { env?: NodeJS.ProcessEnv; boardTools?: boolean; synthesisFails?: boolean };

/** 主循环系统提示含 "Sub-agent model roles"，故按 synthesizer/exploration 专名区分请求归属。 */
const isSynthesis = (request: StreamChatRequest): boolean => request.system.includes("synthesizer of a parallel sub-agent swarm");
const isMember = (request: StreamChatRequest): boolean => request.system.includes("exploration sub-agent") && !isSynthesis(request);
async function setupSwarm(spawnInput: Record<string, unknown>, options: SetupOptions = {}) {
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
  const requests = new Map<string, StreamChatRequest[]>();
  let mainTurn = 0;
  const script = async function* (name: string, request: StreamChatRequest): AsyncIterable<ProviderEvent> {
    requests.set(name, [...(requests.get(name) ?? []), request]);
    if (isSynthesis(request)) {
      if (options.synthesisFails) throw new Error("synthesis boom");
      yield { type: "text_delta", text: "合成报告正文" }; yield { type: "done", stopReason: "end_turn" }; return;
    }
    if (name === "cheap-provider" || isMember(request)) { yield* memberScript(request, options.boardTools); return; }
    if (mainTurn++ > 0) { yield { type: "text_delta", text: "完成" }; yield { type: "done", stopReason: "end_turn" }; return; }
    yield { type: "tool_call", id: "spawn-1", name: "spawn_swarm", input: spawnInput };
    yield { type: "done", stopReason: "tool_use" };
  };
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("main", (request) => script("main", request)));
  providers.register(makeStubProvider("cheap-provider", (request) => script("cheap-provider", request)));
  const settings = await SettingsService.load({ env: options.env ?? {}, filePath: path.join(root, "server-settings.json") });
  const runner = new AgentRunner(sessions, providers, makeFakeCore(), events, pricing, undefined, "zh-CN", 50, undefined, new UsageLog(root));
  runner.setModelRoleResolver(new ModelRoleResolver(settings, providers));
  return { runner, sessionId: session.id, sessions, requests, captured };
}

/** 成员轮次脚本：默认直接回结论；boardTools 时先 post、再 wait 超时、最后收尾。 */
async function* memberScript(request: StreamChatRequest, boardTools?: boolean): AsyncIterable<ProviderEvent> {
  const results = request.messages.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  if (boardTools && !results.some((block) => block.content === "ok")) {
    yield { type: "tool_call", id: `post-${request.messages.length}`, name: "swarm_board_post", input: { text: "发现X", kind: "finding", priority: "high" } };
  } else if (boardTools && !results.some((block) => block.content.includes("(timeout)"))) {
    yield { type: "tool_call", id: `wait-${request.messages.length}`, name: "swarm_wait", input: { any: true, timeoutSeconds: 1 } };
  } else {
    yield { type: "text_delta", text: "成员结论" }; yield { type: "done", stopReason: "end_turn" }; return;
  }
  yield { type: "done", stopReason: "tool_use" };
}

/** 读本次 swarm 的板文件行（swarmId = toolCallId "spawn-1"）；主循环 spawn-1 的 tool_result。 */
async function readBoard(fixture: Fixture): Promise<Array<Record<string, unknown>>> {
  const boardPath = path.join(fixture.sessions.contextRoot(fixture.sessionId), "subagents", "swarm-spawn-1-board.jsonl");
  return (await readFile(boardPath, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

type SpawnResult = { content: string; isError: boolean; subagentTasks?: Array<Record<string, unknown>> };

async function spawnResult(fixture: Fixture): Promise<SpawnResult> {
  const detail = await fixture.sessions.get(fixture.sessionId);
  const block = detail?.messages.filter((message) => message.role === "tool").flatMap((message) => message.content)
    .find((entry) => entry.type === "tool_result" && entry.toolCallId === "spawn-1") as SpawnResult | undefined;
  if (!block) throw new Error("spawn tool_result not found");
  return block;
}
describe("spawn_swarm", () => {
  it("roster/lifecycle 系统贴与 started payload/subagentTasks 携带 role/model", async () => {
    const f = await setupSwarm(
      { prompt_template: "审查 {{item}}", items: ["a.ts", { task: "b.ts", role: "cheap" }], role: "balanced" },
      { env: { OWC_ROLE_MODEL_CHEAP: CHEAP } },
    );
    await f.runner.run(f.sessionId, "派单");
    const board = await readBoard(f);
    const members = (board.find((line) => line.kind === "roster")?.members ?? []) as Array<Record<string, unknown>>;
    // 默认 explore 两项重名 → 后缀去重；taskExcerpt 为填充后 prompt 截断
    expect(members).toMatchObject([
      { index: 1, member: "explore", agent: "explore", model: "main-model", taskExcerpt: "审查 a.ts" },
      { index: 2, member: "explore-2", taskExcerpt: "审查 b.ts" },
    ]);
    const lifecycle = board.filter((line) => line.kind === "lifecycle");
    expect(lifecycle.map((line) => `${line.member}:${line.event}`).sort()).toEqual(["explore-2:finished", "explore-2:started", "explore:finished", "explore:started"]);
    // synthesize 缺省关闭：无合成事件；第一项调用级 balanced 未配置 → 回落会话模型，第二项逐项 cheap
    expect(f.captured.filter((event) => event.type === "subagent.synthesis")).toHaveLength(0);
    expect(f.captured.filter((event) => event.type === "subagent.started").map((event) => event.payload))
      .toMatchObject([{ role: "balanced", model: "main-model" }, { role: "cheap", model: "cheap-model" }]);
    expect(await spawnResult(f)).toMatchObject({ isError: false, subagentTasks: [
      { index: 0, status: "done", role: "balanced", model: "main-model" },
      { index: 1, status: "done", role: "cheap", model: "cheap-model" },
    ] });
  }, 20_000);
  it("成员板工具：post 落板进 digest（kind/priority 保留），swarm_wait 超时正常收尾", async () => {
    const f = await setupSwarm({ prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] }, { boardTools: true });
    await f.runner.run(f.sessionId, "派单");
    const posts = (await readBoard(f)).filter((line) => line.kind === "finding");
    expect(posts.map((line) => `${line.from}:${line.text}:${line.priority}`).sort()).toEqual(["explore-2:发现X:high", "explore:发现X:high"]);
    const result = await spawnResult(f);
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain("Board digest");
    expect(result.content).toContain("by kind: finding=2");
  }, 20_000);
  it("synthesize：一次无工具合成调用、事件 started/finished，报告排在成员结论之前", async () => {
    const f = await setupSwarm(
      { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "cheap" } },
      { env: { OWC_ROLE_MODEL_CHEAP: CHEAP } },
    );
    await f.runner.run(f.sessionId, "派单");
    // 合成请求落在角色 provider：无工具、单条用户消息含成员结论
    const synth = (f.requests.get("cheap-provider") ?? []).filter(isSynthesis);
    expect(synth).toHaveLength(1);
    expect(synth[0]).toMatchObject({ tools: [], model: "cheap-model" });
    expect(synth[0]?.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Member conclusions") });
    const events = f.captured.filter((event) => event.type === "subagent.synthesis");
    expect(events.map((event) => (event.payload as Record<string, unknown>).phase)).toEqual(["started", "finished"]);
    expect(events[1]?.payload).toMatchObject({ status: "done", model: "cheap-model" });
    const result = await spawnResult(f);
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain("Synthesis (cheap → cheap-provider/cheap-model):\n合成报告正文");
    expect(result.content).toContain("Member conclusions");
    expect(result.content.indexOf("Synthesis")).toBeLessThan(result.content.indexOf("Member conclusions"));
  }, 20_000);
  it("合成失败回落纯拼接并标注错误；非法 role 在启动前拒绝整次调用", async () => {
    const failing = await setupSwarm(
      { prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "cheap" } },
      { env: { OWC_ROLE_MODEL_CHEAP: CHEAP }, synthesisFails: true },
    );
    await failing.runner.run(failing.sessionId, "派单");
    const events = failing.captured.filter((event) => event.type === "subagent.synthesis");
    expect(events[1]?.payload).toMatchObject({ phase: "finished", status: "failed", error: expect.stringContaining("synthesis boom") });
    const result = await spawnResult(failing);
    expect(result.isError).toBe(false);
    // 合成失败只标注错误：纯拼接的成员结论不丢
    expect(result.content).toMatch(/Synthesis failed \(cheap[\s\S]*synthesis boom[\s\S]*成员结论/);

    const bogus = await setupSwarm({ prompt_template: "评审 {{item}}", items: ["a.ts", "b.ts"], synthesize: { role: "bogus" } });
    await bogus.runner.run(bogus.sessionId, "派单");
    const rejected = await spawnResult(bogus);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("Unknown model role: bogus");
  }, 20_000);
});
