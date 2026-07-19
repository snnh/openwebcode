import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { Compactor } from "../src/context/compactor.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { appendMemory, parseSedimentSections, readGlobalMemory, readProjectMemory } from "../src/memory.js";
import type { Provider2Client } from "../src/provider2.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-memory-"));
  roots.push(root);
  return root;
}

function createFakeCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async configureSession() { return { sandboxCapability: "advisory" }; },
  };
  return core as unknown as CoreClientLike;
}

async function createRunner(root: string, provider: Provider, dataDir?: string) {
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providers = new ProviderRegistry();
  providers.register(provider);
  const events = new EventBus();
  const captured: AppEvent[] = [];
  events.on("event", (event: AppEvent) => captured.push(event));
  const runner = new AgentRunner(
    sessions, providers, createFakeCore(), events, pricing,
    undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, dataDir,
  );
  return { sessions, runner, captured };
}

describe("appendMemory", () => {
  it("creates a project memory file with header and appends bullets", async () => {
    const root = await tempRoot();
    const file = path.join(root, ".owc", "memory.md");
    const result = await appendMemory(file, ["用户偏好中文回复", " 构建命令是 npm run build "]);
    expect(result).toEqual({ appended: 2 });
    expect(await readFile(file, "utf8")).toBe("# Memory\n- 用户偏好中文回复\n- 构建命令是 npm run build\n");
  });

  it("uses the global header outside .owc and appends to an existing file", async () => {
    const root = await tempRoot();
    const file = path.join(root, "memory.md");
    await appendMemory(file, ["全局事实"]);
    const result = await appendMemory(file, ["又一条"]);
    expect(result).toEqual({ appended: 1 });
    expect(await readFile(file, "utf8")).toBe("# Global Memory\n- 全局事实\n- 又一条\n");
  });

  it("deduplicates facts already present (trim-insensitive)", async () => {
    const root = await tempRoot();
    const file = path.join(root, ".owc", "memory.md");
    await appendMemory(file, ["用户偏好中文回复", "构建命令是 npm run build"]);
    const before = await readFile(file, "utf8");
    const result = await appendMemory(file, ["  用户偏好中文回复 ", "新事实"]);
    expect(result).toEqual({ appended: 1 });
    expect(await readFile(file, "utf8")).toBe(`${before}- 新事实\n`);
    // 全部重复时不重写文件
    expect(await appendMemory(file, ["用户偏好中文回复", "新事实"])).toEqual({ appended: 0 });
    expect(await readFile(file, "utf8")).toBe(`${before}- 新事实\n`);
  });

  it("reads missing memory files as empty strings", async () => {
    const root = await tempRoot();
    expect(await readProjectMemory(root)).toBe("");
    expect(await readGlobalMemory(root)).toBe("");
    await appendMemory(path.join(root, ".owc", "memory.md"), ["项目事实"]);
    expect(await readProjectMemory(root)).toContain("- 项目事实");
  });
});

describe("parseSedimentSections", () => {
  it("parses 关键发现 and 未决事项 bullets, skipping other sections", () => {
    const summary = [
      "目标：",
      "- 实现记忆系统",
      "行动：",
      "- 改了 agent-runner",
      "修改文件：",
      "- server/src/memory.ts",
      "关键发现：",
      "- 压缩入口共有三处",
      "- 数据根可注入 AgentRunner",
      "未决事项：",
      "- 全局记忆 UI 未做",
      "用户明确指令：",
      "- 不要提交代码",
    ].join("\n");
    expect(parseSedimentSections(summary)).toEqual(["压缩入口共有三处", "数据根可注入 AgentRunner", "全局记忆 UI 未做"]);
  });

  it("handles bold headers, half-width colons, blanks and duplicates", () => {
    const summary = [
      "**关键发现：**",
      "",
      "- 发现 A",
      "- 发现 A",
      "* 发现 B",
      "未决事项:",
      "- 待办 X",
      "一段非列表散文",
      "- 不应收录",
      "**用户明确指令**:",
      "- 指令不收录",
    ].join("\n");
    expect(parseSedimentSections(summary)).toEqual(["发现 A", "发现 B", "待办 X"]);
  });

  it("returns an empty array when the sections are absent", () => {
    expect(parseSedimentSections("目标：\n- 无\n行动：\n- 无")).toEqual([]);
  });
});

describe("remember via AgentRunner", () => {
  function rememberProvider(input: Record<string, unknown>, requests: StreamChatRequest[]): Provider {
    let turn = 0;
    return {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          yield { type: "tool_call", id: "remember-1", name: "remember", input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
  }

  it("writes project memory and is auto-approved under ask mode", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    await mkdir(cwd, { recursive: true });
    const requests: StreamChatRequest[] = [];
    const { sessions, runner, captured } = await createRunner(root, rememberProvider({ fact: "用户偏好中文回复" }, requests));

    const session = await sessions.create({ cwd, provider: "fake", model: "test-model" });
    await runner.run(session.id, "记住我的偏好");

    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("remember");
    const memory = await readFile(path.join(cwd, ".owc", "memory.md"), "utf8");
    expect(memory).toBe("# Memory\n- 用户偏好中文回复\n");

    // 工具结果说明写入位置与条数
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "remember-1");
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false });
    expect((toolResult as { content: string }).content).toContain("project memory");
    expect((toolResult as { content: string }).content).toContain("1 fact(s) appended");

    // 会话缺省 ask 模式：remember 自动放行，不挂起、无 permission.request 事件
    expect(captured.some((event) => event.type === "permission.request")).toBe(false);
    expect(captured.some((event) => event.type === "agent.state" && (event.payload as { state?: string }).state === "waiting_permission")).toBe(false);
  });

  it("writes global memory to the data root when scope is global", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    const dataDir = path.join(root, "data");
    await mkdir(cwd, { recursive: true });
    const requests: StreamChatRequest[] = [];
    const { sessions, runner } = await createRunner(root, rememberProvider({ fact: "全局约定", scope: "global" }, requests), dataDir);

    const session = await sessions.create({ cwd, provider: "fake", model: "test-model" });
    await runner.run(session.id, "全局记住");

    expect(await readFile(path.join(dataDir, "memory.md"), "utf8")).toBe("# Global Memory\n- 全局约定\n");
    // 项目记忆不应被创建
    expect(await readProjectMemory(cwd)).toBe("");
  });
});

describe("system prompt memory injection", () => {
  function captureProvider(requests: StreamChatRequest[]): Provider {
    return {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "好" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
  }

  it("injects CLAUDE.md, AGENTS.md, project and global memory when present", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    const dataDir = path.join(root, "data");
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(cwd, "CLAUDE.md"), "项目约定：用 pnpm", "utf8");
    await writeFile(path.join(cwd, "AGENTS.md"), "构建：npm run build", "utf8");
    await writeFile(path.join(cwd, ".owc", "memory.md"), "# Memory\n- 用户偏好中文回复\n", "utf8");
    await writeFile(path.join(dataDir, "memory.md"), "# Global Memory\n- 全局约定\n", "utf8");

    const requests: StreamChatRequest[] = [];
    const { sessions, runner } = await createRunner(root, captureProvider(requests), dataDir);
    const session = await sessions.create({ cwd, provider: "fake", model: "test-model" });
    await runner.run(session.id, "你好");

    const system = requests[0]!.system;
    expect(system).toContain("## CLAUDE.md\n项目约定：用 pnpm");
    expect(system).toContain("## AGENTS.md\n构建：npm run build");
    expect(system).toContain("## Project memory (.owc/memory.md)\n# Memory\n- 用户偏好中文回复");
    expect(system).toContain("## Global memory\n# Global Memory\n- 全局约定");
  });

  it("adds no memory sections when nothing exists", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    await mkdir(cwd, { recursive: true });
    const requests: StreamChatRequest[] = [];
    const { sessions, runner } = await createRunner(root, captureProvider(requests), path.join(root, "data"));
    const session = await sessions.create({ cwd, provider: "fake", model: "test-model" });
    await runner.run(session.id, "你好");

    const system = requests[0]!.system;
    expect(system).toBe(`You are OpenWebCode. The workspace is ${session.cwd}. Respond in zh-CN unless the user explicitly requests another language.`);
  });

  it("truncates a section beyond 8000 characters", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "长".repeat(9_000), "utf8");
    const requests: StreamChatRequest[] = [];
    const { sessions, runner } = await createRunner(root, captureProvider(requests));
    const session = await sessions.create({ cwd, provider: "fake", model: "test-model" });
    await runner.run(session.id, "你好");

    const system = requests[0]!.system;
    expect(system).toContain("…(truncated)");
    expect(system.length).toBeLessThan(9_000);
  });
});

describe("overview compaction sediment", () => {
  function fakeProvider2(text: string): Provider2Client {
    return {
      configured: true,
      model: "fake-cheap-model",
      setConfig() { /* noop */ },
      async complete() {
        return { text, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    } as unknown as Provider2Client;
  }

  it("sediments 关键发现/未决事项 into project memory and dedups on repeat compaction", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    await mkdir(cwd, { recursive: true });
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd, provider: "development", title: "沉淀样例" });
    for (let index = 0; index < 15; index += 1) {
      await store.appendMessage(session.id, index % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `消息 ${index + 1}` }]);
    }
    const summary = [
      "目标：",
      "- 做压缩",
      "关键发现：",
      "- 压缩入口共有三处",
      "未决事项：",
      "- 全局记忆 UI 未做",
      "用户明确指令：",
      "- 不要提交",
    ].join("\n");
    const compactor = new Compactor(store, fakeProvider2(summary), {}, 10);

    const result = await compactor.compact(session.id, "overview");
    expect(result.changed).toBe(true);
    const memoryFile = path.join(cwd, ".owc", "memory.md");
    expect(await readFile(memoryFile, "utf8")).toBe("# Memory\n- 压缩入口共有三处\n- 全局记忆 UI 未做\n");

    // 相同摘要再次压缩：去重，不重复追加
    await store.appendMessage(session.id, "user", [{ type: "text", text: "消息 16" }]);
    const second = await compactor.compact(session.id, "overview");
    expect(second.changed).toBe(true);
    expect(await readFile(memoryFile, "utf8")).toBe("# Memory\n- 压缩入口共有三处\n- 全局记忆 UI 未做\n");
  });

  it("skips sediment when overview falls back to truncated (provider2 unconfigured)", async () => {
    const root = await tempRoot();
    const cwd = path.join(root, "ws");
    await mkdir(cwd, { recursive: true });
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd, provider: "development", title: "降级样例" });
    // 用户消息含「关键发现」字样：规则摘要会带进正文，finalMode 守卫必须挡住误沉淀
    for (let index = 0; index < 15; index += 1) {
      await store.appendMessage(session.id, "user", [{ type: "text", text: `消息 ${index + 1} 关键发现： - 不该沉淀` }]);
    }
    const unconfigured = {
      configured: false,
      model: "",
      setConfig() { /* noop */ },
      async complete() { throw new Error("provider2 not configured"); },
    } as unknown as Provider2Client;
    const compactor = new Compactor(store, unconfigured, {}, 10);

    const result = await compactor.compact(session.id, "overview", { forced: true });
    expect(result.changed).toBe(true);
    expect(result.mode).toBe("truncated");
    expect(existsSync(path.join(cwd, ".owc", "memory.md"))).toBe(false);
  });
});
