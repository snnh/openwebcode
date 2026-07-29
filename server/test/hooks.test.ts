import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { HookRunner, matchesMatcher, normalizeHooksConfig } from "../src/hooks.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];

/** rm 带重试：HookRunner 超时测试会留下孤儿 node 子进程（cmd.exe 被 SIGKILL 后子进程变孤儿），
 * 其 cwd 锁住临时目录，需等 node 自行退出后再删。 */
async function rmWithRetry(target: string, retries = 15, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rmWithRetry(root))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-hooks-"));
  roots.push(root);
  return root;
}

/** 写项目级 <cwd>/.owc/hooks.json */
async function writeProjectHooks(cwd: string, config: unknown): Promise<void> {
  await mkdir(path.join(cwd, ".owc"), { recursive: true });
  await writeFile(path.join(cwd, ".owc", "hooks.json"), JSON.stringify(config), "utf8");
}

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
  it("PreToolUse exit 0 -> 放行（返回 {}）", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command: CMD.exit0 }],
    });
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), new EventBus());
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    expect(outcome).toEqual({});
  });

  it("PreToolUse exit 2 -> {blocked:true, reason} 且 reason 含 stderr 文本", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command: CMD.exit2Stderr("denied-by-hook") }],
    });
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), new EventBus());
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain("denied-by-hook");
  });

  it("PreToolUse exit 1 -> 不阻断，发 hook.failed 事件", async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command: CMD.exit1 }],
    });
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    expect(outcome).toEqual({});
    const failed = captured.find((e) => e.type === "hook.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { exitCode?: number }).exitCode).toBe(1);
  });

  it("超时（慢命令）-> 不阻断，hook.failed payload 含 timeout:true", { timeout: 30_000 }, async () => {
    const cwd = await tempRoot();
    await writeProjectHooks(cwd, {
      PreToolUse: [{ matcher: "bash", command: CMD.timeout }],
    });
    const events = new EventBus();
    const captured: AppEvent[] = [];
    events.on("event", (e: AppEvent) => captured.push(e));
    const runner = new HookRunner(path.join(cwd, "nonexistent-global.json"), events);
    const start = Date.now();
    const outcome = await runner.run("PreToolUse", { sessionId: "s1", cwd, tool: "bash", input: {} });
    const elapsed = Date.now() - start;
    expect(outcome).toEqual({});
    const failed = captured.find((e) => e.type === "hook.failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { timeout?: boolean }).timeout).toBe(true);
    // HookRunner 内部 5s 超时
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(15000);
  });

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
