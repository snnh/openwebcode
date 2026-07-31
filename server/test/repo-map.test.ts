import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { RepoMapGenerator, DEFAULT_REPO_MAP_BUDGET } from "../src/context/repo-map.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { makeFakeScanCore } from "./helpers/fake-scan-core.js";
import { tempRoot } from "./helpers/temp-roots.js";

const SAMPLE_FILES = [
  "README.md", "package.json", "tsconfig.json",
  "src/index.ts", "src/app.ts", "src/util/deep/nested/file.ts",
  "node_modules/dep/index.js", "node_modules/dep/sub/x.js",
  "dist/bundle.js", ".git/HEAD",
  "docs/guide.md", "docs/api/reference.md",
];

describe("RepoMapGenerator", () => {
  it("生成目录树与关键文件提示，token 归因与文本一致", async () => {
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore(SAMPLE_FILES, state));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.text).toContain("Key files: package.json, README.md, tsconfig.json");
    expect(result.text).toContain("src/");
    expect(result.text).toContain("docs/");
    expect(result.truncated).toBe(false);
    expect(result.tokens).toBeGreaterThan(0);
    expect(state.scanCalls).toBeGreaterThan(0);
  });

  it("默认排除 node_modules/.git/dist，会话 excludes 叠加生效", async () => {
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore([...SAMPLE_FILES, "secret/private.txt"], state));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo", excludes: ["secret"] });
    expect(result.text).not.toContain("node_modules");
    expect(result.text).not.toContain("bundle.js");
    expect(result.text).not.toContain("HEAD");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("private.txt");
    expect(result.text).toContain("src/");
  });

  it("超预算时收缩深度并如实标注 truncated", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/mod${i % 20}/sub/file${i}.ts`);
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore(many, state));
    const full = await generator.generate({ sessionId: "s1", cwd: "/repo", budget: 100_000 });
    const bounded = await generator.generate({ sessionId: "s1", cwd: "/repo", budget: 200 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toContain("[repo map truncated");
    expect(bounded.tokens).toBeLessThanOrEqual(200);
    expect(bounded.text.length).toBeLessThan(full.text.length);
    expect(bounded.text).not.toContain("deep/nested");
  });

  it("极小预算硬截断仍不超预算且带标注", async () => {
    const many = Array.from({ length: 2000 }, (_, i) => `a${i % 50}/b${i % 30}/c${i % 10}/f${i}.ts`);
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore(many, state));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo", budget: 64 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[repo map truncated");
    expect(result.tokens).toBeLessThanOrEqual(80);
  });

  it("缓存：根目录 mtime 未变且 TTL 内不重扫；mtime 变化后重扫", async () => {
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore(SAMPLE_FILES, state));
    const first = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(first.cached).toBe(false);
    const scansAfterFirst = state.scanCalls;
    const second = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(second.cached).toBe(true);
    expect(state.scanCalls).toBe(scansAfterFirst);
    // 同扫描、不同渲染配置（预算变化）也不重扫
    await generator.generate({ sessionId: "s1", cwd: "/repo", budget: 500 });
    expect(state.scanCalls).toBe(scansAfterFirst);
    state.mtime = 2;
    const third = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(third.cached).toBe(false);
    expect(state.scanCalls).toBeGreaterThan(scansAfterFirst);
  });

  it("空工作区返回空树而不报错", async () => {
    const state = { mtime: 1, scanCalls: 0 };
    const generator = new RepoMapGenerator(makeFakeScanCore([], state));
    const result = await generator.generate({ sessionId: "s1", cwd: "/repo" });
    expect(result.truncated).toBe(false);
    expect(result.entryCount).toBe(0);
  });
});

describe("repo map 提示词注入与 repo_map 工具", () => {
  async function setup(options?: { repoMapEnabled?: boolean; agentMode?: "plan" | "code"; toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }> }) {
    const root = await tempRoot("owc-repomap-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updateConfig(session.id, { provider: "fake", model: "model", ...(options?.agentMode ? { agentMode: options.agentMode } : {}) });
    // ask 权限模式：repo_map 应像其他只读工具一样自动放行（不挂起审批）
    await sessions.updatePermissions(session.id, "ask", []);
    if (options?.repoMapEnabled === false) await sessions.updateRepoMapSettings(session.id, { enabled: false });

    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const requests: StreamChatRequest[] = [];
    const toolCalls = options?.toolCalls ?? [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request: StreamChatRequest) {
        const isFirst = requests.length === 0;
        requests.push(request);
        if (isFirst && toolCalls.length > 0) {
          for (const tc of toolCalls) yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const state = { mtime: 1, scanCalls: 0 };
    const core = makeFakeScanCore(SAMPLE_FILES, state);
    const runner = new AgentRunner(sessions, providers, core, events, pricing);
    await runner.run(session.id, "hello");
    return { session, sessions, requests, published, state };
  }

  it("repo map 注入在动态侧：system 稳定前缀不含，systemSuffix 含", async () => {
    const { requests } = await setup();
    expect(requests[0]?.system).not.toContain("Repository map");
    expect(requests[0]?.systemSuffix).toContain("## Repository map");
    expect(requests[0]?.systemSuffix).toContain("src/");
    expect(requests[0]?.systemSuffix).not.toContain("node_modules");
  });

  it("会话关闭后不再注入也不扫描", async () => {
    const { requests, state } = await setup({ repoMapEnabled: false });
    expect(requests[0]?.systemSuffix ?? "").not.toContain("Repository map");
    expect(state.scanCalls).toBe(0);
  });

  it("repo map tokens 归因到 watermark 事件的 repoMap 段", async () => {
    const { published } = await setup();
    const watermark = published.find((event) => event.type === "context.watermark");
    expect(watermark).toBeDefined();
    const segments = (watermark!.payload as { segments: { repoMap: number } }).segments;
    expect(segments.repoMap).toBeGreaterThan(0);
  });

  it("repo_map 工具执行：返回预算内的树文本", async () => {
    const { sessions, session, requests } = await setup({ toolCalls: [{ name: "repo_map", id: "rm-1", input: {} }] });
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "rm-1");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect((toolResult as { content: string }).content).toContain("src/");
    // 工具定义已进入下发列表
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("repo_map");
  });

  it("repo_map 非法预算参数 → isError", async () => {
    const { sessions, session } = await setup({ toolCalls: [{ name: "repo_map", id: "rm-3", input: { budget: 10 } }] });
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "rm-3");
    expect(toolResult!.isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("budget");
  });

  it("plan 模式下 repo_map 作为只读工具放行", async () => {
    const { sessions, session } = await setup({ agentMode: "plan", toolCalls: [{ name: "repo_map", id: "rm-4", input: {} }] });
    const detail = await sessions.get(session.id);
    const toolResult = detail?.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result" && c.toolCallId === "rm-4");
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect((toolResult as { content: string }).content).not.toContain("Plan 模式为只读");
  });
});
