import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { isReadOnlyCommand } from "../src/agent/readonly-command.js";
import { filterBuiltInTools, READ_ONLY_TOOL_NAMES, toolAllowedBySession } from "../src/agent/tool-schemas.js";
import { buildServer } from "../src/app.js";
import type { CoreClient, CoreClientLike, CoreInfo } from "../src/core-client.js";
import type { ModelProfile } from "../src/context/model-profile.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import type { McpManager } from "../src/mcp/manager.js";
import { ProviderRegistry, type ProviderEvent, type ProviderTool, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SkillRegistry } from "../src/skills.js";
import type { SearchProvider } from "../src/web-tools.js";
import { tempRoot } from "./helpers/temp-roots.js";

const GENERAL_MARKER = "general-purpose coding sub-agent";
const EXPLORE_MARKER = "read-only exploration sub-agent";
const isSubRequest = (request: StreamChatRequest): boolean =>
  request.system.includes(GENERAL_MARKER) || request.system.includes(EXPLORE_MARKER);

function fakeTool(name: string): ProviderTool {
  return { name, description: name, inputSchema: { type: "object", additionalProperties: false } };
}

const FAKE_CORE_INFO: CoreInfo = {
  version: "0.8.0-test", protocolVersion: "1.0", platform: "windows", sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: true, fsWriteBase64: true, jobControl: false, fsHash: true, fsScanPagination: true, fsWatch: true },
  limits: { maxFrameBytes: 33_554_432, maxWriteBase64Bytes: 20_971_520, maxHashBytes: 16_777_216, maxStatManyPaths: 128, maxStatManyPathBytes: 262_144, maxScanEntries: 256, maxScanDepth: 16, maxScanNodes: 2_048, maxWatches: 16, maxWatchEvents: 128, maxConcurrentJobs: 4, maxJobOutputBytes: 524_288 },
};

function fakeCore(): CoreClientLike {
  const core = {
    on() { return core; },
    async ping() { return FAKE_CORE_INFO; },
    async configureSession() { return { sandboxCapability: "advisory" as const }; },
    async readFile() { return { path: "x", content: "", totalLines: 0, encoding: "utf-8", truncated: false }; },
    async writeFile() { return { ok: true as const }; },
    async editFile() { return { matches: 1 }; },
    async globFiles() { return { paths: [], truncated: false }; },
    async grepFiles() { return { matches: [], truncated: false }; },
    async run() { return { exitCode: 0, durationMs: 1, truncated: false }; },
  };
  return core as unknown as CoreClientLike;
}

interface LoopOptions {
  model?: string;
  profile?: ModelProfile;
  toolsAllow?: string[];
  toolsDeny?: string[];
  core?: CoreClientLike;
  skills?: SkillRegistry;
  mcp?: McpManager;
  search?: SearchProvider;
  /** 每轮脚本：mainTurn 仅主循环递增（子代理固定 0）。 */
  script: (request: StreamChatRequest, mainTurn: number) => ProviderEvent[];
}

/** agent loop 夹具：会话（含会话级工具名单）+ 记录请求的 stub provider + 事件类型采集。 */
async function makeLoop(options: LoopOptions) {
  const root = await tempRoot("owc-tool-filter-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const model = options.model ?? "test-model";
  const lists = {
    ...(options.toolsAllow ? { toolsAllow: options.toolsAllow } : {}),
    ...(options.toolsDeny ? { toolsDeny: options.toolsDeny } : {}),
  };
  const session = await sessions.create({ cwd: root, provider: "fake", model, ...lists });
  // 手动快照：避免自动检查点触发快照后端探测（updateConfig 的 undefined=清除语义同样要求原样透传名单）
  await sessions.updateConfig(session.id, { provider: "fake", model, snapshotMode: "manual", ...lists });
  await sessions.updatePermissions(session.id, "yolo", []);
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const requests: StreamChatRequest[] = [];
  const subRequests: StreamChatRequest[] = [];
  const observed: string[] = [];
  const events = new EventBus();
  events.on("event", (event) => observed.push(event.type));
  let mainTurn = 0;
  const provider = {
    name: "fake",
    async *streamChat(request: StreamChatRequest) {
      if (isSubRequest(request)) { subRequests.push(request); yield* options.script(request, 0); return; }
      requests.push(request);
      yield* options.script(request, mainTurn++);
    },
  };
  const providers = new ProviderRegistry();
  providers.register(provider);
  const runner = new AgentRunner(
    sessions, providers, options.core ?? fakeCore(), events, pricing,
    undefined, "zh-CN", 50, options.profile ? () => options.profile! : undefined,
    undefined, options.skills, options.mcp, undefined, undefined, undefined, undefined, options.search,
  );
  return { runner, sessionId: session.id, sessions, requests, subRequests, observed, pricing, providers };
}

const noToolsProfile: ModelProfile = {
  id: "no-tools-model",
  provider: "test",
  contextWindow: 32_000,
  capabilities: { modalities: ["text"], imageOutput: false, thinking: [], effort: [], tools: false },
};

const withToolsProfile: ModelProfile = {
  ...noToolsProfile, id: "tools-model", capabilities: { ...noToolsProfile.capabilities, tools: true },
};

describe("内置工具会话过滤（filterBuiltInTools / toolAllowedBySession）", () => {
  const tools = ["bash", "read_file", "write_file", "glob", "ask_user"].map(fakeTool);
  const namesWith = (allow?: string[], deny?: string[]): string[] => filterBuiltInTools(tools, allow, deny).map((tool) => tool.name);

  it("allow 白名单 / deny 再剔除 / 未知名忽略 / 交互类始终保留", () => {
    expect(filterBuiltInTools(tools)).toBe(tools);
    expect(filterBuiltInTools(tools, [], [])).toBe(tools);
    expect(namesWith(["read_file", "glob"])).toEqual(["read_file", "glob", "ask_user"]);
    expect(namesWith(["read_file", "glob", "write_file"], ["write_file"])).toEqual(["read_file", "glob", "ask_user"]);
    expect(namesWith(undefined, ["bash", "write_file"])).toEqual(["read_file", "glob", "ask_user"]);
    expect(namesWith(["read_file", "no_such_tool"])).toEqual(["read_file", "ask_user"]);
    expect(namesWith(undefined, ["no_such_tool"])).toEqual(["bash", "read_file", "write_file", "glob", "ask_user"]);
    expect(toolAllowedBySession("ask_user", ["read_file"], ["ask_user"])).toBe(true);
    expect(toolAllowedBySession("exit_plan_mode", ["read_file"], ["exit_plan_mode"])).toBe(true);
    expect(toolAllowedBySession("bash", ["read_file"])).toBe(false);
  });

  it("READ_ONLY_TOOL_NAMES 只读集；与全局只读名单叠加 = 交集", () => {
    for (const name of ["read_file", "glob", "grep", "repo_map", "code_search"]) expect(READ_ONLY_TOOL_NAMES, name).toContain(name);
    for (const name of ["bash", "write_file", "edit_file"]) expect(READ_ONLY_TOOL_NAMES, name).not.toContain(name);
    // 全局只读名单（--read-only → toolsAllow）+ 会话 deny：叠加后只留交集（bash/write_file 本就出局）
    expect(namesWith([...READ_ONLY_TOOL_NAMES], ["glob"])).toEqual(["read_file", "ask_user"]);
  });
});

describe("会话级工具过滤（agent loop 集成）", () => {
  it("主循环：allow/deny 过滤内置工具，ask_user 保留，mcp__ 工具不受会话名单影响", async () => {
    const mcp = { toolsFor: async () => ({ tools: [fakeTool("mcp__test__echo")], warnings: [] }) } as unknown as McpManager;
    const loop = await makeLoop({
      toolsAllow: ["read_file", "grep"], toolsDeny: ["grep", "mcp__test__echo"], mcp,
      script: () => [{ type: "text_delta", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    });
    await loop.runner.run(loop.sessionId, "你好");
    const names = loop.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("read_file");
    expect(names).toContain("ask_user");
    expect(names).toContain("mcp__test__echo"); // MCP/扩展工具由用户显式配置，不受会话名单影响
    for (const absent of ["grep", "bash", "write_file", "edit_file"]) expect(names).not.toContain(absent);
  });

  it("子代理继承：general 被 toolsDeny 剔除；explore 只读集与 toolsAllow 取交集（spawn_task 旧名等价）", async () => {
    const spawnScript = (kind: string) => (request: StreamChatRequest, mainTurn: number): ProviderEvent[] => {
      if (request.system.includes(kind)) return [{ type: "text_delta", text: "子代理结论" }, { type: "done", stopReason: "end_turn" }];
      if (mainTurn === 0) return [{ type: "tool_call", id: "spawn-1", name: "spawn_task", input: { prompt: "看看工作区", agent: kind === GENERAL_MARKER ? "general" : undefined } }, { type: "done", stopReason: "tool_use" }];
      return [{ type: "text_delta", text: "完成" }, { type: "done", stopReason: "end_turn" }];
    };
    const general = await makeLoop({ toolsDeny: ["bash", "write_file", "edit_file"], script: spawnScript(GENERAL_MARKER) });
    await general.runner.run(general.sessionId, "派生子代理");
    expect(general.subRequests).toHaveLength(1);
    const deniedNames = general.subRequests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(deniedNames).toContain("read_file");
    for (const absent of ["bash", "write_file", "edit_file"]) expect(deniedNames).not.toContain(absent);

    // 白名单须显式含 spawn_task（旧名），否则主代理自身也拿不到派发工具；explore 默认只读集 ∩ 白名单
    const explore = await makeLoop({ toolsAllow: ["read_file", "spawn_task"], script: spawnScript(EXPLORE_MARKER) });
    await explore.runner.run(explore.sessionId, "派生探索子代理");
    expect(explore.subRequests[0]?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });
});

describe("会话工具限制 REST", () => {
  it("POST /api/sessions 持久化与形状校验；PUT /config 设置/清除/缺省保持", async () => {
    const root = await tempRoot("owc-tool-filter-api-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register({ name: "anthropic", async *streamChat() { yield { type: "done", stopReason: "end_turn" }; } });
    const app = await buildServer({ core: {} as CoreClient, sessions, agent: { isRunning: () => false } as unknown as AgentRunner, events: new EventBus(), providers, pricing });
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", toolsAllow: ["read_file", "glob"], toolsDeny: ["bash"] } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ toolsAllow: ["read_file", "glob"], toolsDeny: ["bash"] });
      for (const invalid of [{ toolsAllow: "read_file" }, { toolsDeny: ["bash", 1] }]) {
        const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: root, provider: "anthropic", model: "m", ...invalid } });
        expect(response.statusCode).toBe(400);
      }

      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "m" });
      const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/sessions/${session.id}/config`, payload });
      expect((await put({ toolsAllow: ["read_file"], toolsDeny: ["grep"] })).statusCode).toBe(200);
      expect(await sessions.get(session.id)).toMatchObject({ toolsAllow: ["read_file"], toolsDeny: ["grep"] });
      await put({ model: "m2" }); // 缺省保持不变
      expect(await sessions.get(session.id)).toMatchObject({ toolsAllow: ["read_file"], toolsDeny: ["grep"] });
      await put({ toolsAllow: null, toolsDeny: null }); // null 清除
      expect(await sessions.get(session.id)).not.toHaveProperty("toolsAllow");
      expect(await sessions.get(session.id)).not.toHaveProperty("toolsDeny");
      await put({ toolsAllow: ["read_file"] });
      await put({ toolsAllow: [] }); // 空数组同样清除
      expect(await sessions.get(session.id)).not.toHaveProperty("toolsAllow");
      expect((await put({ toolsAllow: "read_file" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("AgentRunner tool capability gating", () => {
  it("tools=false 模型：不注入工具与工具提示，意外 tool_call 记为错误结果且不执行", async () => {
    const run = vi.fn();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; }, run } as unknown as CoreClientLike;
    const loop = await makeLoop({
      model: noToolsProfile.id, profile: noToolsProfile, core,
      skills: { listFor: vi.fn(async () => [{ name: "hidden", description: "must not be injected" }]), find: vi.fn() } as unknown as SkillRegistry,
      mcp: { toolsFor: vi.fn(async () => ({ tools: [fakeTool("mcp__test__echo")], warnings: [] })) } as unknown as McpManager,
      search: { name: "configured", async search() { return []; } },
      script: (_request, mainTurn) => mainTurn === 0
        // 兼容 provider 仍可能在未提供工具时发出 tool_call（且 stopReason 不对）：必须不执行、不污染历史
        ? [{ type: "tool_call", id: "unexpected-bash", name: "bash", input: { cmd: "should-not-run" } }, { type: "done", stopReason: "end_turn" }]
        : [{ type: "text_delta", text: "已根据工具错误继续回复。" }, { type: "done", stopReason: "end_turn" }],
    });
    await loop.runner.run(loop.sessionId, "请处理这个问题");
    expect(loop.requests).toHaveLength(2);
    for (const request of loop.requests) {
      expect(request.tools).toEqual([]);
      for (const marker of ["## Work discipline", "read_file", "todo_write", "load_skill", "subagent", "spawn_task", "web_search"]) {
        expect(request.system, marker).not.toContain(marker);
      }
    }
    expect(run).not.toHaveBeenCalled();
    const detail = await loop.sessions.get(loop.sessionId);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail?.messages[2]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolCallId: "unexpected-bash", isError: true, content: "Tool calls are disabled for the selected model: bash" }),
    ]);
  });

  it("MCP 不可用：降级不注入其 schema、发布 mcp.degraded 且对话继续", async () => {
    const loop = await makeLoop({
      model: withToolsProfile.id, profile: withToolsProfile,
      mcp: { toolsFor: vi.fn(async () => { throw new Error("MCP handshake timed out"); }) } as unknown as McpManager,
      script: () => [{ type: "text_delta", text: "MCP 不可用时仍可回复。" }, { type: "done", stopReason: "end_turn" }],
    });
    await loop.runner.run(loop.sessionId, "继续工作");
    const names = loop.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("bash");
    expect(names).not.toContain("mcp__test__echo");
    expect(loop.observed).toContain("mcp.degraded");
    expect(loop.observed).not.toContain("agent.error");
  });
});

describe("isReadOnlyCommand", () => {
  it("放行纯只读单命令、探查形态与复合管道", () => {
    const allowed = [
      "ls", "  ls   ", "true", "head -80 file.txt", "cat package.json", "grep -rn \"foo\" src/", "ls /tmp",
      "git status", "git status --porcelain", "git log --oneline -5", "git diff HEAD~1", "git rev-parse --abbrev-ref HEAD",
      "find . -name \"*.ts\" -not -path \"*/node_modules/*\" | head -10", "echo \"a>b\"", "echo 'a;b && c'",
      "cd /x && echo hi && ls", "cd /x; ls; echo done", "ls server/test 2>/dev/null | head", "ls >/dev/null && echo ok",
      "sort f", "date", "sed s/a/b/ f", "find . -printf '%p\\n'",
    ];
    for (const cmd of allowed) expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    // 用户报告的典型复合探查命令
    expect(isReadOnlyCommand("cd /share/work/openwebcode && echo \"=== release.yml ===\" && head -80 .github/workflows/release.yml && ls server/test 2>/dev/null | head; find server -maxdepth 3 -name \"*.test.ts\" -not -path \"*/node_modules/*\" | head -10 && ls server/vitest.config.ts server/vitest.config.mts 2>/dev/null")).toBe(true);
  });

  it("拒绝写重定向、命令替换与非白名单命令", () => {
    const denied = [
      "echo x > file", "echo x >> file", "echo x > /tmp/f", "echo x 2> err.txt", "echo x 2>&1", "echo x &> file",
      "head x 3> f", "cat < file", "cat << EOF", "echo x >/dev/nullx", "echo $(rm -rf /)", "echo `rm -rf /`",
      "echo \"$(whoami)\"", "head x && rm -rf /", "head x || touch y", "head x & rm -rf /", "env rm -rf /",
      "command rm -rf /", "awk 'BEGIN{system(\"rm -rf /\")}'", "xargs rm -rf /", "sudo ls", "nohup ls &",
      "npm test", "node -e \"process.exit()\"", "./script.sh", "/usr/bin/ls", "FOO=bar ls",
    ];
    for (const cmd of denied) expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    expect(isReadOnlyCommand("echo '$(rm -rf /)'")).toBe(true); // 单引号内不执行
  });

  it("拒绝白名单命令的写形态、git 写/外部执行选项与非 POSIX sh 形态", () => {
    const denied = [
      "find . -exec rm {} \\;", "find . -delete", "find . -fprintf out '%p'", "find . -fprint out", "find . -fls out",
      "sed -i s/a/b/ f", "sed --in-place s/a/b/ f", "sed -i.bak s/a/b/ f", "sed '1e id' f", "sed -e 'e' f",
      "sed 'w out' f", "sed 'r /etc/passwd' f", "sed 's/a/b/e' f", "sed 's/a/b/w out' f", "sed 's/a/b/ w' f",
      "sed -f script.sed f", "sed --file=script.sed f", "sort -o out f", "date -s 2026-01-01",
      "git diff --ext-diff", "git show --textconv", "git log --ext-diff -1", "git diff --output=/tmp/x",
      "git push", "git commit -m x", "git checkout main", "git reset --hard", "git config user.name x", "git -C /x status", "git",
    ];
    for (const cmd of denied) expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    const allowed = [
      "sed -n '1,10p' f", "sed -nE 's/foo/bar/p' f", "sed -n '/ERROR/,/END/p' log", "sed 's/a\\/b/c/' f",
      "sed 's/a/b/2gp' f", "sed 'y/abc/def/' f", "sed '$d' f", "sed '5!d' f", "sed -n '/x/{s/y/z/;p}' f", "sed 'a hello' f",
    ];
    for (const cmd of allowed) expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    // cmd/pwsh 不认 POSIX 转义与单引号：按 sh 判定安全、按 cmd 实际会执行出第二条命令
    expect(isReadOnlyCommand("echo x \\& del y", "sh")).toBe(true);
    expect(isReadOnlyCommand("echo x \\& del y", "cmd")).toBe(false);
    expect(isReadOnlyCommand("ls", "cmd")).toBe(false);
    expect(isReadOnlyCommand("ls", "pwsh")).toBe(false);
    expect(isReadOnlyCommand("ls", "sh")).toBe(true);
    expect(isReadOnlyCommand("ls")).toBe(true); // 缺省按 sh
  });
});
