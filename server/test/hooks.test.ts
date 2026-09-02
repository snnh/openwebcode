import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { Compactor } from "../src/context/compactor.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import type { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { FastModelClient } from "../src/fast-model.js";
import { HookRunner, matchesMatcher, normalizeHooksConfig } from "../src/hooks.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeCore } from "./helpers/fake-core.js";
import { tempRootRetry, writeProjectHooks } from "./helpers/temp-dir.js";

const tempRoot = (): Promise<string> => tempRootRetry("owc-hooks-");
const tempRootEvents = (): Promise<string> => tempRootRetry("owc-hooks-events-");

/**
 * 跨平台 shell 命令策略：HookRunner 在 win32 用 cmd.exe、否则 sh。命令统一用
 * `node -e "..."` 带引号形式--引号保护脚本内的 `;`（sh 下分号是命令分隔符，会截断
 * 脚本）；win32 下 HookRunner 的 spawn 设了 windowsVerbatimArguments:true，引号原样
 * 透传给 cmd.exe，node 收到完整脚本。stderr 文本用连字符避免 shell 分词问题。
 */
const CMD = {
  exit0: 'node -e "process.exit(0)"',
  exit1: 'node -e "process.exit(1)"',
  exit2Stderr: (msg: string) => `node -e "process.stderr.write('${msg}');process.exit(2)"`,
  exit1Stderr: (msg: string) => `node -e "process.stderr.write('${msg}');process.exit(1)"`,
  timeout: 'node -e "setTimeout(function(){process.exit(0)},6000)"',
};

describe("matchesMatcher", () => {
  it.each([
    {
      name: "精确名：bash 命中 bash，不命中 read_file",
      checks: [
        { matcher: "bash", tool: "bash", expected: true },
        { matcher: "bash", tool: "read_file", expected: false },
      ],
    },
    {
      name: "前缀 bash* 命中 bash，不命中 read_file",
      checks: [
        { matcher: "bash*", tool: "bash", expected: true },
        { matcher: "bash*", tool: "read_file", expected: false },
      ],
    },
    {
      name: "前缀 mcp__* 命中任意 mcp__ 工具，不命中 bash",
      checks: [
        { matcher: "mcp__*", tool: "mcp__filesystem_read", expected: true },
        { matcher: "mcp__*", tool: "mcp__any_tool", expected: true },
        { matcher: "mcp__*", tool: "bash", expected: false },
      ],
    },
    {
      name: "'*' 全中（任意工具名）",
      checks: [
        { matcher: "*", tool: "bash", expected: true },
        { matcher: "*", tool: "read_file", expected: true },
        { matcher: "*", tool: "mcp__anything", expected: true },
      ],
    },
    {
      name: "无 tool 时仅 '*' 命中（UserPromptSubmit/Stop/SessionStart 语义）",
      checks: [
        { matcher: "*", tool: undefined, expected: true },
        { matcher: "bash", tool: undefined, expected: false },
        { matcher: "bash*", tool: undefined, expected: false },
        { matcher: "mcp__*", tool: undefined, expected: false },
      ],
    },
  ])("$name", ({ checks }) => {
    for (const check of checks) {
      expect(matchesMatcher(check.matcher, check.tool), `${check.matcher} vs ${check.tool}`).toBe(check.expected);
    }
  });
});

describe("normalizeHooksConfig", () => {
  it("合法条目保留（覆盖全部白名单事件）", () => {
    const config = normalizeHooksConfig({
      PreToolUse: [{ matcher: "bash", command: "echo pre" }],
      PostToolUse: [{ matcher: "*", command: "echo post" }],
      UserPromptSubmit: [{ matcher: "*", command: "echo u" }],
      Stop: [{ matcher: "*", command: "echo s" }],
      SessionStart: [{ matcher: "*", command: "echo ss" }],
    });
    expect(config.PreToolUse).toEqual([{ matcher: "bash", command: "echo pre" }]);
    expect(config.PostToolUse).toEqual([{ matcher: "*", command: "echo post" }]);
    expect(config.UserPromptSubmit).toEqual([{ matcher: "*", command: "echo u" }]);
    expect(config.Stop).toEqual([{ matcher: "*", command: "echo s" }]);
    expect(config.SessionStart).toEqual([{ matcher: "*", command: "echo ss" }]);
  });

  it("非法条目丢弃：空 matcher / 空 command / null / 非对象", () => {
    const config = normalizeHooksConfig({
      PreToolUse: [
        { matcher: "bash", command: "echo ok" },
        { matcher: "", command: "echo bad-matcher" },
        { matcher: "bash", command: "" },
      ],
    });
    expect(config.PreToolUse).toEqual([{ matcher: "bash", command: "echo ok" }]);
    const junk = normalizeHooksConfig({
      PreToolUse: [null, undefined, "string", 42, { matcher: "bash", command: "echo ok" }],
    });
    expect(junk.PreToolUse).toEqual([{ matcher: "bash", command: "echo ok" }]);
  });

  it("非白名单事件名（如 Unknown）丢弃", () => {
    const config = normalizeHooksConfig({
      Unknown: [{ matcher: "bash", command: "echo ok" }],
      PreToolUse: [{ matcher: "bash", command: "echo ok" }],
    });
    expect((config as Record<string, unknown>).Unknown).toBeUndefined();
    expect(config.PreToolUse).toHaveLength(1);
  });

  it("非对象输入返回 {}", () => {
    expect(normalizeHooksConfig(null)).toEqual({});
    expect(normalizeHooksConfig(undefined)).toEqual({});
    expect(normalizeHooksConfig("string")).toEqual({});
    expect(normalizeHooksConfig(42)).toEqual({});
    expect(normalizeHooksConfig(true)).toEqual({});
    expect(normalizeHooksConfig([])).toEqual({});
  });
});

describe("HookRunner.run 语义", () => {
  it.each<{
    name: string;
    command: string;
    check: (events: AppEvent[], outcome: Record<string, unknown>, elapsedMs?: number) => void;
  }>([
    {
      name: "exit 0 -> 放行（返回 {}）",
      command: CMD.exit0,
      check: (_events, outcome) => {
        expect(outcome).toEqual({});
      },
    },
    {
      name: "exit 2 -> {blocked:true, reason} 且 reason 含 stderr 文本",
      command: CMD.exit2Stderr("denied-by-hook"),
      check: (_events, outcome) => {
        expect(outcome.blocked).toBe(true);
        expect(outcome.reason).toContain("denied-by-hook");
      },
    },
    {
      name: "exit 1 -> 不阻断，发 hook.failed 事件",
      command: CMD.exit1,
      check: (events, outcome) => {
        expect(outcome).toEqual({});
        const failed = events.find((e) => e.type === "hook.failed");
        expect(failed).toBeDefined();
        expect((failed!.payload as { exitCode?: number }).exitCode).toBe(1);
      },
    },
    {
      name: "超时（慢命令）-> 不阻断，hook.failed payload 含 timeout:true",
      command: CMD.timeout,
      check: (events, outcome, elapsed) => {
        expect(outcome).toEqual({});
        const failed = events.find((e) => e.type === "hook.failed");
        expect(failed).toBeDefined();
        expect((failed!.payload as { timeout?: boolean }).timeout).toBe(true);
        // HookRunner 内部 5s 超时
        expect(elapsed).toBeGreaterThanOrEqual(4500);
        expect(elapsed).toBeLessThan(15000);
      },
    },
  ])("PreToolUse 退出码矩阵：$name", async ({ command, check }) => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command }],
    });
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
    const start = Date.now();
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    const elapsed = Date.now() - start;
    check(captured, outcome, elapsed);
  }, 30_000);

  it("PostToolUse exit 2 -> 不否决（仅 PreToolUse 有 blocked 语义），返回 {}", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PostToolUse: [{ matcher: "write_file", command: CMD.exit2Stderr("post-fail") }],
    });
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
    const outcome = await runner.run("PostToolUse", { sessionId: "s1", cwd, tool: "write_file", input: { path: "a.txt" } });
    expect(outcome).toEqual({});
    // exit 2 在 PostToolUse 走 "其他非零" 分支 -> hook.failed 事件
    expect(captured.some((e) => e.type === "hook.failed")).toBe(true);
  });

  it("项目级 + 全局合并、项目在前（两份 hooks.json，matcher 不同，两者都执行）", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command: CMD.exit1Stderr("project-marker") }],
    });
    const globalPath = path.join(cwd, "global-hooks.json");
    await writeFile(globalPath, JSON.stringify({
      PreToolUse: [{ matcher: "bash", command: CMD.exit1Stderr("global-marker") }],
    }), "utf8");
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(globalPath, events);
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    expect(outcome).toEqual({});
    const failedEvents = captured.filter((e) => e.type === "hook.failed");
    expect(failedEvents).toHaveLength(2);
    // 项目在前：第一条 stderr 含 project-marker，第二条含 global-marker
    expect((failedEvents[0]!.payload as { stderr: string }).stderr).toContain("project-marker");
    expect((failedEvents[1]!.payload as { stderr: string }).stderr).toContain("global-marker");
  });

  it("坏 JSON -> 告警事件且正常执行（不炸）", async () => {
    const cwd = await tempRoot();
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await writeFile(path.join(cwd, ".owc", "hooks.json"), "{not valid json", "utf8");
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    expect(outcome).toEqual({});
    const configFailed = captured.find((e) =>
      e.type === "hook.failed" && (e.payload as { event?: string }).event === "config");
    expect(configFailed).toBeDefined();
    expect((configFailed!.payload as { stderr: string }).stderr).toContain("hooks.json");
  });
});

describe("新事件集（提交⑪）", () => {
  it("normalizeHooksConfig 接受全部新事件名", () => {
    const config = normalizeHooksConfig({
      PreCompact: [{ matcher: "*", command: "echo pre-compact" }],
      PostCompact: [{ matcher: "*", command: "echo post-compact" }],
      SessionEnd: [{ matcher: "*", command: "echo end" }],
      Notification: [{ matcher: "*", command: "echo notify" }],
      SubagentStart: [{ matcher: "*", command: "echo start" }],
      SubagentStop: [{ matcher: "*", command: "echo stop" }],
    });
    expect(config.PreCompact).toHaveLength(1);
    expect(config.PostCompact).toHaveLength(1);
    expect(config.SessionEnd).toHaveLength(1);
    expect(config.Notification).toHaveLength(1);
    expect(config.SubagentStart).toHaveLength(1);
    expect(config.SubagentStop).toHaveLength(1);
  });

  it("PreCompact exit 2 -> blocked（Pre* 类阻断语义）", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreCompact: [{ matcher: "*", command: CMD.exit2Stderr("no-compact") }],
    });
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), new EventBus());
    const outcome = await runner.run("PreCompact", { sessionId: "s1", cwd, compact: { strategy: "overview", forced: true } });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("no-compact");
  });

  it.each(["PostCompact", "SessionEnd", "Notification", "SubagentStart", "SubagentStop"] as const)(
    "%s exit 2 -> 不阻断（仅 Pre* 类有 blocked 语义），发 hook.failed",
    async (event) => {
      const cwd = await tempRoot();
      await writeProjectHooks(cwd, {
        [event]: [{ matcher: "*", command: CMD.exit2Stderr("ignored") }],
      });
      const events = new EventBus();
      const captured: AppEvent[] = [];
      events.on("event", (e: AppEvent) => captured.push(e));
      const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
      const outcome = await runner.run(event, { sessionId: "s1", cwd });
      expect(outcome).toEqual({});
      expect(captured.some((e) => e.type === "hook.failed")).toBe(true);
    },
  );
});

describe("PreToolUse hook via AgentRunner (e2e)", () => {
  async function setup(toolCall: { name: string; id: string; input: Record<string, unknown> }) {
    const root = await tempRoot();
    // 项目级 hooks.json：PreToolUse exit 2 + stderr，matcher "*" 全中
    await writeProjectHooks(root, {
      PreToolUse: [{ matcher: "*", command: CMD.exit2Stderr("denied-by-e2e-hook") }],
    });
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    // yolo 放行写工具，使 hook 门禁成为唯一拦截点
    await sessions.updatePermissions(session.id, "yolo", []);

    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const requests: StreamChatRequest[] = [];
    const writeFileCalls: { path: string; content: string }[] = [];
    const bashRunCalls: { cmd: string }[] = [];

    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        const isFirst = requests.length === 0;
        requests.push(request);
        if (isFirst) {
          yield { type: "tool_call", id: toolCall.id, name: toolCall.name, input: toolCall.input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "已处理" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);

    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
      async readFile() { return { content: "file content" }; },
      async globFiles() { return { matches: [] }; },
      async grepFiles() { return { matches: [] }; },
      async writeFile(request: { path: string; content: string }) {
        writeFileCalls.push({ path: request.path, content: request.content });
        return { ok: true };
      },
      async editFile() { return { matches: 1 }; },
      async run(request: { cmd: string }) {
        bashRunCalls.push({ cmd: request.cmd });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async cleanupSession() { return { ok: true }; },
      setRequestTimeoutMs() {},
      start() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
      stop() { return Promise.resolve(); },
      ping() { return Promise.resolve({ version: "0.0.0", platform: "test" }); },
      listFiles() { return Promise.resolve({ entries: [], truncated: false }); },
    } as unknown as CoreClientLike;

    // globalPath 指向不存在的文件，仅项目级生效
    const hooks = new HookRunner(path.join(root, "nonexistent-global.json"), events);
    const agent = new AgentRunner(
      sessions, providers, core, events, pricing,
      undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      hooks,
    );
    await agent.run(session.id, "test message");
    const detail = await sessions.get(session.id);
    return { detail, writeFileCalls, bashRunCalls, requests };
  }

  it.each([
    { tool: { name: "write_file", id: "wf-1", input: { path: "test.txt", content: "hello" } }, callsKey: "writeFileCalls" as const },
    { tool: { name: "bash", id: "bash-1", input: { cmd: "echo hi" } }, callsKey: "bashRunCalls" as const },
  ])("PreToolUse hook 阻断 $tool.name -> tool_result isError + stderr 文本，无副作用", async ({ tool, callsKey }) => {
    const result = await setup(tool);
    const toolResult = result.detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === tool.id);
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("denied-by-e2e-hook");
    // 工具未真正执行副作用
    expect(result[callsKey]).toHaveLength(0);
  });
});

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
    const root = await tempRootEvents();
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
    const root = await tempRootEvents();
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
    const root = await tempRootEvents();
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
    const root = await tempRootEvents();
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
    const root = await tempRootEvents();
    const marker = path.join(root, "compact.jsonl");
    await writeProjectHooks(root, {
      PreCompact: [{ matcher: "*", command: appendMarkerCommand(marker) }],
      PostCompact: [{ matcher: "*", command: appendMarkerCommand(marker) }],
    });
    const calls: Array<{ system: string; prompt: string }> = [];
    // 固定输出需同时通过 toolcalls 与 overview 两套校验（同一 stub 服务两种策略）
    const dualValid = "- [工具] bash → 完成\n- [用户] 目标：压缩前缀\n- [助手] 行动：执行摘要\n- [用户] 关键发现：模型调用完成\n- [助手] 未决事项：无";
    const { sessions, session, compactor } = await setupCompactor(root, fakeFastModel(dualValid, calls));
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
    const root = await tempRootEvents();
    await writeProjectHooks(root, {
      PreCompact: [{ matcher: "*", command: `node -e "process.stderr.write('no-compact');process.exit(2)"` }],
    });
    const calls: Array<{ system: string; prompt: string }> = [];
    const { session, compactor } = await setupCompactor(root, fakeFastModel("- [工具] bash → 完成\n- [用户] 目标：压缩前缀\n- [助手] 行动：执行摘要\n- [用户] 关键发现：模型调用完成\n- [助手] 未决事项：无", calls));
    const result = await compactor.compact(session.id, "toolcalls");
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("no-compact");
    expect(calls).toHaveLength(0);
  });
});

describe("工具形态别名（env-sim）下的钩子 payload", () => {
  it("PreToolUse/PostToolUse 的 tool 为内置名（matcher 按内置名命中），别名经 toolAlias 附带", async () => {
    const root = await tempRootEvents();
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
    const root = await tempRootEvents();
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
