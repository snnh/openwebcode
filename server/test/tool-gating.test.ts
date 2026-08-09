import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import type { ModelProfile } from "../src/context/model-profile.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import type { McpManager } from "../src/mcp/manager.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { SkillRegistry } from "../src/skills.js";
import type { SearchProvider } from "../src/web-tools.js";
import { tempRoot } from "./helpers/temp-roots.js";

const noToolsProfile: ModelProfile = {
  id: "no-tools-model",
  provider: "test",
  contextWindow: 32_000,
  capabilities: {
    modalities: ["text"],
    imageOutput: false,
    thinking: [],
    effort: [],
    tools: false,
  },
};

describe("AgentRunner tool capability gating", () => {
  it("does not inject tools or tool prompts for a tools=false model, and persists a rejected unexpected tool call", async () => {
    const root = await tempRoot("owc-tool-gating-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: noToolsProfile.id });
    // Avoid an unrelated GitShadow checkpoint in this focused test.
    await sessions.updateConfig(session.id, { provider: "fake", model: noToolsProfile.id, snapshotMode: "manual" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();

    const requests: StreamChatRequest[] = [];
    let turn = 0;
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        if (turn++ === 0) {
          // A broken compatible provider can still emit a tool_call even though it was not offered,
          // and can pair it with the wrong stop reason. It must not execute or corrupt history.
          yield { type: "tool_call", id: "unexpected-bash", name: "bash", input: { cmd: "should-not-run" } };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "已根据工具错误继续回复。" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const run = vi.fn();
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
      run,
    } as unknown as CoreClientLike;
    const listFor = vi.fn(async () => [{ name: "hidden", description: "must not be injected" }]);
    const skillRegistry = {
      listFor,
      find: vi.fn(),
    } as unknown as SkillRegistry;
    const toolsFor = vi.fn(async () => ({
      tools: [{ name: "mcp__test__echo", description: "echo", inputSchema: { type: "object", properties: {} } }],
      warnings: [],
    }));
    const mcp = {
      toolsFor,
    } as unknown as McpManager;
    const search: SearchProvider = { name: "configured", async search() { return []; } };
    const runner = new AgentRunner(
      sessions,
      providers,
      core,
      new EventBus(),
      pricing,
      undefined,
      "zh-CN",
      50,
      () => noToolsProfile,
      undefined,
      skillRegistry,
      mcp,
      undefined,
      undefined,
      undefined,
      undefined,
      search,
    );

    await runner.run(session.id, "请处理这个问题");

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.tools).toEqual([]);
      expect(request.system).not.toContain("## Work discipline");
      expect(request.system).not.toContain("read_file");
      expect(request.system).not.toContain("todo_write");
      expect(request.system).not.toContain("load_skill");
      expect(request.system).not.toContain("spawn_task");
      expect(request.system).not.toContain("web_search");
    }
    expect(run).not.toHaveBeenCalled();

    const detail = await sessions.get(session.id);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(detail?.messages[2]?.content).toEqual([
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "unexpected-bash",
        isError: true,
        content: "Tool calls are disabled for the selected model: bash",
      }),
    ]);
  });

  it("degrades an unavailable MCP service without advertising its schema or aborting the dialogue", async () => {
    const root = await tempRoot("owc-tool-gating-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "tools-model" });
    await sessions.updateConfig(session.id, { provider: "fake", model: "tools-model", snapshotMode: "manual" });
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async *streamChat(request) {
        requests.push(request);
        yield { type: "text_delta", text: "MCP 不可用时仍可回复。" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const core = {
      on() { return core; },
      async configureSession() { return { sandboxCapability: "advisory" }; },
    } as unknown as CoreClientLike;
    const events = new EventBus();
    const observed: string[] = [];
    events.on("event", (event) => observed.push(event.type));
    const toolsFor = vi.fn(async () => { throw new Error("MCP handshake timed out"); });
    const mcp = { toolsFor } as unknown as McpManager;
    const toolsProfile: ModelProfile = {
      ...noToolsProfile,
      id: "tools-model",
      capabilities: { ...noToolsProfile.capabilities, tools: true },
    };
    const runner = new AgentRunner(
      sessions,
      providers,
      core,
      events,
      pricing,
      undefined,
      "zh-CN",
      50,
      () => toolsProfile,
      undefined,
      undefined,
      mcp,
    );

    await runner.run(session.id, "继续工作");

    expect(toolsFor).toHaveBeenCalledOnce();
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("bash");
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("mcp__test__echo");
    expect(observed).toContain("mcp.degraded");
    expect(observed).not.toContain("agent.error");
  });
});
