import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { loadMcpConfig } from "../src/mcp/config.js";
import { connectMcpServer } from "../src/mcp/client.js";
import { McpManager } from "../src/mcp/manager.js";
import { ProviderRegistry, type Provider } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-mcp-"));
  roots.push(root);
  return root;
}

const FIXTURE = path.join(__dirname, "fixtures", "fake-mcp-server.mjs");
const STDIO_CONFIG = { command: process.execPath, args: [FIXTURE] };

async function writeConfig(dir: string, relative: string, config: unknown): Promise<void> {
  const filePath = path.join(dir, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(config), "utf8");
}

describe("MCP config loading", () => {
  it("merges global and project configs, project wins; invalid entries are skipped", async () => {
    const root = await tempDir();
    const cwd = path.join(root, "work");
    await writeConfig(root, "mcp.json", { mcpServers: { alpha: STDIO_CONFIG, shared: STDIO_CONFIG, broken: { nonsense: 1 } } });
    await writeConfig(cwd, path.join(".owc", "mcp.json"), { mcpServers: { shared: { url: "http://127.0.0.1:9/mcp" } } });

    const { servers, skipped } = await loadMcpConfig(root, cwd);
    expect(Object.keys(servers).sort()).toEqual(["alpha", "shared"]);
    expect(servers.shared).toMatchObject({ url: "http://127.0.0.1:9/mcp" });
    expect(skipped).toEqual(["broken"]);
    expect((await loadMcpConfig(path.join(root, "missing"))).servers).toEqual({});
  });
});

describe("MCP stdio client", () => {
  it("handshakes, lists tools, calls tools and surfaces isError", async () => {
    const client = await connectMcpServer("fake", STDIO_CONFIG, { timeoutMs: 10_000 });
    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);

      const echo = await client.callTool("echo", { text: "你好 MCP" });
      expect(echo).toEqual({ content: "你好 MCP", isError: false });

      const failed = await client.callTool("fail", {});
      expect(failed).toEqual({ content: "boom", isError: true });

      await expect(client.callTool("missing", {})).rejects.toThrow(/unknown tool/);
    } finally {
      await client.close();
    }
  });

  it("rejects the handshake when the command does not exist", async () => {
    await expect(connectMcpServer("ghost", { command: "definitely-not-a-real-binary-owc" }, { timeoutMs: 10_000 }))
      .rejects.toThrow();
  });
});

describe("MCP streamable HTTP client", () => {
  it("handles JSON and SSE responses and echoes the session id", async () => {
    const seen: Array<{ method: string; sessionId: string | undefined }> = [];
    const http = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        seen.push({ method: message.method ?? "?", sessionId: request.headers["mcp-session-id"] as string | undefined });
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http-fake" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }
            : { content: [{ type: "text", text: "pong" }] };
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (message.method === "tools/list") {
          // SSE 变体：响应以 text/event-stream 返回
          response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-123" });
          response.end(`data: ${payload}\n\n`);
        } else {
          response.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": "s-123" } : {}) });
          response.end(payload);
        }
      });
    });
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const client = await connectMcpServer("http", { url: `http://127.0.0.1:${address.port}/mcp` }, { timeoutMs: 10_000 });
    try {
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ping"]);
      expect(await client.callTool("ping", {})).toEqual({ content: "pong", isError: false });
      // initialize 之后所有请求都带会话 id
      expect(seen.filter((entry) => entry.method !== "initialize").every((entry) => entry.sessionId === "s-123")).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("McpManager", () => {
  it("injects namespaced tools, degrades failed servers and routes calls", async () => {
    const root = await tempDir();
    await writeConfig(root, "mcp.json", {
      mcpServers: {
        fake: STDIO_CONFIG,
        ghost: { command: "definitely-not-a-real-binary-owc" },
      },
    });
    const manager = new McpManager(root, { timeoutMs: 10_000 });
    try {
      const { tools, warnings } = await manager.toolsFor(root);
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo", "mcp__fake__fail"]);
      expect(tools[0]?.description).toContain("[fake]");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ghost");

      const result = await manager.callTool(root, "mcp__fake__echo", { text: "路由测试" });
      expect(result).toEqual({ content: "路由测试", isError: false });
      await expect(manager.callTool(root, "mcp__fake__missing", {})).rejects.toThrow();
      await expect(manager.callTool(root, "mcp__nope__x", {})).rejects.toThrow(/Unknown MCP tool/);
    } finally {
      await manager.close();
    }
  });

  it("keeps tool bindings across concurrent cwds", async () => {
    const root = await tempDir();
    const cwdA = path.join(root, "a");
    const cwdB = path.join(root, "b");
    await writeConfig(cwdA, path.join(".owc", "mcp.json"), { mcpServers: { fake: STDIO_CONFIG } });
    await writeConfig(cwdB, path.join(".owc", "mcp.json"), { mcpServers: { other: STDIO_CONFIG } });
    const manager = new McpManager(root, { timeoutMs: 10_000 });
    try {
      const a = await manager.toolsFor(cwdA);
      expect(a.tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo", "mcp__fake__fail"]);
      const b = await manager.toolsFor(cwdB);
      expect(b.tools.map((tool) => tool.name)).toEqual(["mcp__other__echo", "mcp__other__fail"]);
      // B 的 toolsFor 不得清除 A 正在使用的绑定
      expect((await manager.callTool(cwdA, "mcp__fake__echo", { text: "并发" })).content).toBe("并发");
    } finally {
      await manager.close();
    }
  });

  it("reconnects after config change and after idle sweep", async () => {
    const root = await tempDir();
    await writeConfig(root, "mcp.json", { mcpServers: { fake: STDIO_CONFIG } });
    const manager = new McpManager(root, { timeoutMs: 10_000, idleMs: 50, sweepMs: 25 });
    try {
      const first = await manager.toolsFor(root);
      expect(first.tools).toHaveLength(2);

      // 空闲扫描后连接被断开，再次 toolsFor 自动重连
      await new Promise((resolve) => setTimeout(resolve, 150));
      const second = await manager.toolsFor(root);
      expect(second.warnings, "重连不应产生告警").toEqual([]);
      expect(second.tools).toHaveLength(2);

      // 配置变化（换成不存在的命令）：旧连接被丢弃，降级为告警
      await writeConfig(root, "mcp.json", { mcpServers: { fake: { command: "definitely-not-a-real-binary-owc" } } });
      const third = await manager.toolsFor(root);
      expect(third.tools).toHaveLength(0);
      expect(third.warnings[0]).toContain("fake");
    } finally {
      await manager.close();
    }
  });
});

describe("MCP tools in agent runs", () => {
  it("injects mcp tools into the provider call and executes them end to end", async () => {
    const root = await tempDir();
    await writeConfig(root, "mcp.json", { mcpServers: { fake: STDIO_CONFIG } });
    const sessions = new SessionStore(path.join(root, "store", "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "store", "pricing.json"));
    await pricing.initialize();
    let streamCalls = 0;
    const provider: Provider = {
      name: "anthropic",
      async *streamChat(request) {
        streamCalls += 1;
        if (streamCalls === 1 && request.tools?.some((tool) => tool.name === "mcp__fake__echo")) {
          yield { type: "tool_call", id: "call-1", name: "mcp__fake__echo", input: { text: "agent 调用 MCP" } };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const mcp = new McpManager(root, { timeoutMs: 10_000 });
    try {
      const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, mcp);
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "claude-haiku-4-5" });
      // MCP 工具默认 ask；测试直接放行
      await sessions.updatePermissions(session.id, "yolo", []);
      await runner.run(session.id, "调用 MCP");

      const stored = await sessions.get(session.id);
      const toolMessage = stored?.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content[0]).toMatchObject({ type: "tool_result", content: "agent 调用 MCP", isError: false });
    } finally {
      await mcp.close();
    }
  });

  it("publishes mcp.degraded once per distinct warning set", async () => {
    const root = await tempDir();
    await writeConfig(root, "mcp.json", { mcpServers: { ghost: { command: "definitely-not-a-real-binary-owc" } } });
    const sessions = new SessionStore(path.join(root, "store", "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "store", "pricing.json"));
    await pricing.initialize();
    const provider: Provider = {
      name: "anthropic",
      async *streamChat() {
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const providers = new ProviderRegistry();
    providers.register(provider);
    const events = new EventBus();
    const published: AppEvent[] = [];
    events.on("event", (event: AppEvent) => published.push(event));
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const mcp = new McpManager(root, { timeoutMs: 10_000 });
    try {
      const runner = new AgentRunner(sessions, providers, core, events, pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, mcp);
      const session = await sessions.create({ cwd: root, provider: "anthropic", model: "claude-haiku-4-5" });
      await runner.run(session.id, "第一次");
      await runner.run(session.id, "第二次");

      const degraded = published.filter((event) => event.type === "mcp.degraded");
      expect(degraded).toHaveLength(1);
      expect(degraded[0]?.payload).toMatchObject({ message: expect.stringContaining("ghost") });
    } finally {
      await mcp.close();
    }
  });
});
