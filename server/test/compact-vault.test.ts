import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { Compactor } from "../src/context/compactor.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import type { CoreClient } from "../src/core-client.js";
import { EventBus, type AppEvent } from "../src/events/event-bus.js";
import { ContextManager } from "../src/context/context-manager.js";
import { CompactVaultService, chunkMessages, loadVaultIndex, parseSectionList, renderChunk } from "../src/extensions/compact-vault.js";
import { parseVaultIndexJson, recallMemory, reinjectVaultIndex, type VaultHostApi } from "../src/extensions/compact-vault-host.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionPermission } from "../src/extensions/types.js";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 构造一条带工具调用的消息（验证归档保留真实内容、索引不含 toolcall）。 */
function textMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text }] };
}

function toolCallMessage(id: string, toolName: string, input: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-07-20T00:00:00.000Z",
    content: [{ type: "tool_call", id: `call-${id}`, name: toolName, input }],
  };
}

function toolResultMessage(id: string, callId: string, content: string): ChatMessage {
  return {
    id,
    role: "tool",
    createdAt: "2026-07-20T00:00:00.000Z",
    content: [{ type: "tool_result", toolCallId: callId, content, isError: false }],
  };
}

/** n 条纯文本 user 消息（快速压缩路径的通用输入）。 */
function plainMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => textMessage(`m${index}`, "user", `x${index}`));
}

/** 快速模型 stub：Pass 1 按块输出目录条目，Pass 2 输出目录索引；可注入指令段。 */
function vaultFastModel(extraIndexSections = ""): { client: FastModelClient; calls: string[]; providers: ProviderRegistry } {
  const calls: string[] = [];
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", async function* (request) {
    const last = request.messages.at(-1);
    const prompt = last?.content.find((block) => block.type === "text")?.text ?? "";
    calls.push(prompt.slice(0, 120));
    if (prompt.includes("对话转录")) {
      const file = /转录文件：(\S+)/.exec(prompt)?.[1] ?? "segments/seg-001.md";
      yield { type: "text_delta", text: `KEY: goals\nTITLE: 目标\nFILES: ${file}\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nFILES: ${file}\nDESC: 采用方案 Y` };
    } else if (prompt.includes("待压缩对话共")) {
      // Pass 2：目录式索引（发给主模型的 vault 摘要）
      yield { type: "text_delta", text: `[归档索引] 早前共 ${prompt.match(/待压缩对话共 (\d+) 条消息/)?.[1] ?? "?"} 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。\n- 目标 (key=goals)：用户要求实现 X\n- 实现方案 (key=impl)：采用方案 Y${extraIndexSections}` };
    } else {
      // 默认 Compactor（扩展未启用）路径：输出含小节名的合规 overview，过压缩输出校验
      yield { type: "text_delta", text: `目标：\n- 压缩早期对话\n行动：\n- 生成结构化概览\n修改文件：\n- 无\n关键发现：\n- 需求与回答一一对应\n未决事项：\n- 无` };
    }
    yield { type: "usage", inputTokens: 10, outputTokens: 10, cacheRead: 0, cacheWrite: 0 };
    yield { type: "done", stopReason: "end_turn" };
  }));
  return { client: new FastModelClient(providers, { provider: "test-stub", model: "fast-m" }), calls, providers };
}

async function makeSession(messages: ChatMessage[]): Promise<{ sessions: SessionStore; sessionId: string }> {
  const root = await tempRoot("owc-vault-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "m1" });
  for (const message of messages) {
    await sessions.appendMessage(session.id, message.role, message.content);
  }
  return { sessions, sessionId: session.id };
}

async function compactSession(messages: ChatMessage[], options: {
  chunkSize?: number; keepTail?: number; fastModel?: FastModelClient; providers?: ProviderRegistry;
  getConfig?: () => Record<string, unknown>;
} = {}) {
  const { sessions, sessionId } = await makeSession(messages);
  const fast = options.fastModel ? { client: options.fastModel, providers: options.providers } : vaultFastModel();
  if (!fast.providers) throw new Error("providers is required when a custom fast model is supplied");
  const service = new CompactVaultService(sessions, fast.client, fast.providers, { ...(options.getConfig ? { getConfig: options.getConfig } : {}) });
  const result = await service.compact(sessionId, { ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}), ...(options.keepTail !== undefined ? { keepTail: options.keepTail } : {}) });
  return { sessions, sessionId, service, result };
}

describe("compact-vault unit helpers", () => {
  it("chunks messages by size and clamps to >= 1", () => {
    const messages = Array.from({ length: 10 }, (_, index) => textMessage(`m${index}`, "user", "x"));
    expect(chunkMessages(messages, 4).map((chunk) => chunk.length)).toEqual([4, 4, 2]);
    expect(chunkMessages(messages, 0)).toHaveLength(10);
  });

  it("parses KEY/TITLE/FILES/DESC section lists tolerantly", () => {
    const parsed = parseSectionList(`说明文字\nKEY: Goals\nTITLE: 目标\nFILES: segments/seg-001.md\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nDESC: 无文件字段\n---\nKEY: broken\n`);
    expect(parsed).toEqual([
      { key: "goals", title: "目标", files: "segments/seg-001.md", desc: "用户要求实现 X" },
      { key: "impl", title: "实现方案", desc: "无文件字段" },
    ]);
    expect(parsed[0]?.key).toBe("goals");
    expect(parsed[1]?.files).toBeUndefined();
  });

  it("renders chunks with full tool call and result content", () => {
    const chunk = [toolCallMessage("a1", "bash", { cmd: "ls -la" }), toolResultMessage("t1", "call-a1", "file1\nfile2")];
    const text = renderChunk(chunk, "segments/seg-001.md");
    expect(text).toContain("【assistant】");
    expect(text).toContain("【tool】");
    expect(text).toContain('{"cmd":"ls -la"}');
    expect(text).toContain("file1\nfile2");
  });

  it("loadVaultIndex returns null for missing/corrupt index", async () => {
    const root = await tempRoot("owc-vaultidx-");
    expect(await loadVaultIndex(root)).toBeNull();
    await writeFile(path.join(root, "index.json"), "not json", "utf8");
    expect(await loadVaultIndex(root)).toBeNull();
  });

  it("host parseVaultIndexJson rejects invalid shapes", () => {
    expect(parseVaultIndexJson("nope")).toBeNull();
    expect(parseVaultIndexJson(JSON.stringify({ uptoIndex: 3, sections: [] }))).toEqual({ uptoIndex: 3, sections: [] });
    expect(parseVaultIndexJson(JSON.stringify({ uptoIndex: "x", sections: [] }))).toBeNull();
  });
});

describe("CompactVaultService.compact", () => {
  it("archives the full transcript, writes the directory index and marks the ledger as vault", async () => {
    const messages: ChatMessage[] = [
      toolCallMessage("tc1", "bash", { cmd: "pwd" }),
      toolResultMessage("tr1", "call-tc1", "secret-path-content"),
    ];
    for (let index = 0; index < 15; index += 1) {
      messages.push(textMessage(`u${index}`, "user", `需求 ${index}`));
      messages.push(textMessage(`a${index}`, "assistant", `回答 ${index}`));
    }
    const { sessions, sessionId, result } = await compactSession(messages, { chunkSize: 10 });
    expect(result.changed).toBe(true);
    expect(result.mode).toBe("vault");
    // 保留最近 10 条消息：32 条消息 → uptoIndex 22
    expect(result.uptoIndex).toBe(22);

    const compactDir = path.join(sessions.contextRoot(sessionId), "compact");
    const segments = await readdir(path.join(compactDir, "segments"));
    expect(segments).toEqual(["seg-001.md", "seg-002.md", "seg-003.md"]);
    // 归档保留完整真实内容（含 tool_call/tool_result 全文）
    const segText = await readFile(path.join(compactDir, "segments", "seg-001.md"), "utf8");
    expect(segText).toContain("需求 0");
    expect(segText).toContain("secret-path-content");
    expect(segText).toContain('{"cmd":"pwd"}');

    const index = await loadVaultIndex(compactDir);
    expect(index?.uptoIndex).toBe(22);
    expect(index?.sections.map((section) => section.key)).toEqual(["goals", "impl"]);
    expect(index?.sections[0]?.files).toEqual(["segments/seg-001.md"]);
    expect(index?.chunkFiles).toHaveLength(3);

    const ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.mode).toBe("vault");
    expect(ledger.compacted?.summary).toContain("recall_memory(keys=[...])");
    expect(ledger.compacted?.summary).toContain("key=goals");
    expect(ledger.compacted?.summary).not.toContain("secret-path-content");
    expect(result.summary).toBe(ledger.compacted?.summary);
  });

  it("reports changed=false when there is no new span", async () => {
    const { sessionId, service } = await compactSession(plainMessages(12));
    const second = await service.compact(sessionId);
    expect(second.changed).toBe(false);
    expect(second.reason).toContain("没有新的可压缩区段");
  });

  it("requires a configured fast model", async () => {
    const { sessions, sessionId } = await makeSession(plainMessages(12));
    const service = new CompactVaultService(sessions, new FastModelClient(new ProviderRegistry()), new ProviderRegistry());
    await expect(service.compact(sessionId)).rejects.toThrow(/快速模型未配置/);
  });

  it("accumulates user instructions across compactions", async () => {
    const { client: firstClient, providers: firstProviders } = vaultFastModel("\n用户明确指令：\n- 不要删除文档");
    const { sessions, sessionId } = await makeSession(plainMessages(12));
    const service = new CompactVaultService(sessions, firstClient, firstProviders);
    await service.compact(sessionId);
    let ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.instructions).toEqual(["不要删除文档"]);

    // 追加消息后再压缩：旧指令跨段保留
    const { client: secondClient, providers: secondProviders } = vaultFastModel("\n用户明确指令：\n- 保持接口不变");
    for (let index = 0; index < 4; index += 1) await sessions.appendMessage(sessionId, "user", [{ type: "text", text: `more ${index}` }]);
    const secondService = new CompactVaultService(sessions, secondClient, secondProviders);
    await secondService.compact(sessionId);
    ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.instructions).toEqual(["不要删除文档", "保持接口不变"]);
  });
});

describe("CompactVaultService.readFile", () => {
  it("reads files inside compact/ and rejects escapes", async () => {
    const { sessionId, service } = await compactSession(plainMessages(12));
    expect(await service.readFile(sessionId, "index.json")).toContain("goals");
    expect(await service.readFile(sessionId, "missing.md")).toBeNull();
    await expect(service.readFile(sessionId, "../ledger.json")).rejects.toThrow(/escapes/);
    await expect(service.readFile(sessionId, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(service.readFile(sessionId, "C:/windows/win.ini")).rejects.toThrow(/relative/);
    await expect(service.readFile(sessionId, "")).rejects.toThrow(/relative/);
  });
});

describe("compact-vault host side", () => {
  function makeApi(contents: Record<string, string | null>, modelText = "提炼结果"): { api: VaultHostApi; modelCalls: number } {
    let modelCalls = 0;
    return {
      modelCalls,
      api: {
        readVaultFile: async (_sessionId, relative) => ({ content: relative in contents ? contents[relative] : null }),
        modelComplete: async () => { modelCalls += 1; return { text: modelText }; },
      },
    };
  }

  it("recall_memory resolves keys to files and returns the fast-model extract", async () => {
    const contents: Record<string, string> = {
      "index.json": JSON.stringify({ uptoIndex: 10, sections: [{ key: "goals", title: "目标", files: ["segments/seg-001.md"], desc: "x" }] }),
      "segments/seg-001.md": "完整内容 A",
    };
    const { api } = makeApi(contents);
    const result = await recallMemory(api, { keys: ["goals"], query: "目标是什么" }, {}, "s1");
    expect(result).toBe("提炼结果");
  });

  it("recall_memory reports unknown keys with the available key list", async () => {
    const contents: Record<string, string> = {
      "index.json": JSON.stringify({ uptoIndex: 5, sections: [{ key: "goals", title: "目标", files: [], desc: "x" }] }),
    };
    const { api } = makeApi(contents);
    const result = await recallMemory(api, { keys: ["nope"] }, {}, "s1");
    expect(result).toContain("可用 key：goals");
  });

  it("recall_memory requires sessionId and falls back to raw fragments when the fast model fails", async () => {
    const contents: Record<string, string> = {
      "index.json": JSON.stringify({ uptoIndex: 5, sections: [{ key: "goals", title: "目标", files: ["segments/seg-001.md"], desc: "x" }] }),
      "segments/seg-001.md": "片段原文",
    };
    const api: VaultHostApi = {
      readVaultFile: async (_sessionId, relative) => ({ content: relative in contents ? contents[relative] : null }),
      modelComplete: async () => { throw new Error("fast model down"); },
    };
    await expect(recallMemory(api, { keys: ["goals"] }, {}, undefined)).rejects.toThrow(/sessionId/);
    const fallback = await recallMemory(api, { keys: ["goals"] }, {}, "s1");
    expect(fallback).toContain("片段原文");
  });

  it("reinjects the directory index when a non-vault compaction overwrote it", async () => {
    const contents: Record<string, string> = {
      "index.json": JSON.stringify({ uptoIndex: 8, sections: [{ key: "goals", title: "目标", files: ["segments/seg-001.md"], desc: "用户要求 X" }] }),
    };
    const { api } = makeApi(contents);
    const payload = {
      sessionId: "s1",
      cwd: "/tmp",
      messages: [textMessage("u1", "user", "hi")],
      ledger: { round: 1, entries: [], compacted: { summary: "default overview", instructions: [] } },
    };
    const result = await reinjectVaultIndex(api, payload);
    expect(result.messages?.[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("recall_memory") });
    expect(result.messages?.[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("key=goals") });

    // vault 模式或没有压缩时不回注
    expect(await reinjectVaultIndex(api, { ...payload, ledger: { round: 1, entries: [], compacted: { summary: "vault index", instructions: [], mode: "vault" } } })).toEqual({});
    expect(await reinjectVaultIndex(api, { ...payload, ledger: { round: 1, entries: [] } })).toEqual({});
    // 无归档时静默（按会话区分）
    const emptyApi: VaultHostApi = { ...api, readVaultFile: async () => ({ content: null }) };
    expect(await reinjectVaultIndex(emptyApi, { ...payload, sessionId: "other" })).toEqual({});
  });
});

describe("compact-vault integration", () => {
  const STORAGE_ENTRY = `
export function activate(api) {
  api.registerTool({ name: "vread", description: "x" }, async (input) =>
    JSON.stringify(await api.context.readVaultFile(String(input.sessionId), String(input.path))));
}
`;

  async function installFixture(manager: ExtensionManager, root: string, options: { id?: string; permissions: ExtensionPermission[]; entry: string }): Promise<string> {
    const id = options.id ?? "sample";
    const source = path.join(root, `fixture-src-${id}`);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "manifest.json"), JSON.stringify({
      id, name: id, version: "1.0.0", description: "test fixture", apiVersion: "1", permissions: options.permissions, entry: "index.js",
    }), "utf8");
    await writeFile(path.join(source, "index.js"), options.entry, "utf8");
    await manager.install(source);
    return id;
  }

  /** 集成公共装配：会话存储 + 会话（rows 对 user/assistant 消息）+ vault 服务 + 扩展管理器 + pricing。 */
  async function makeVaultEnv(rows = 12, withAssistant = true) {
    const root = await tempRoot("owc-vaultapp-");
    const events = new EventBus();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "m1" });
    for (let index = 0; index < rows; index += 1) {
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: `需求 ${index}` }]);
      if (withAssistant) await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: `回答 ${index}` }]);
    }
    const { client, providers: fastProviders } = vaultFastModel();
    const vaultService = new CompactVaultService(sessions, client, fastProviders);
    const manager = new ExtensionManager(path.join(root, "data"), events, { sessions, vaultService });
    await manager.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    return { root, events, sessions, session, client, fastProviders, vaultService, manager, pricing };
  }

  type VaultEnv = Awaited<ReturnType<typeof makeVaultEnv>>;

  interface VaultAppOptions {
    rows?: number;
    withAssistant?: boolean;
    /** 设置时启用 compact-vault 扩展并注入 keepTail。 */
    keepTail?: number;
    /** 安装并启用 fixture 扩展。 */
    fixture?: { permissions: ExtensionPermission[]; entry: string };
    /** 注入默认 Compactor（扩展未启用路径）。 */
    compactor?: boolean;
  }

  /** makeVaultEnv + buildServer 装配 + 自动关闭 app/manager。 */
  async function withVaultApp<T>(options: VaultAppOptions, fn: (env: VaultEnv, app: FastifyInstance) => T | Promise<T>): Promise<T> {
    const env = await makeVaultEnv(options.rows ?? 12, options.withAssistant ?? true);
    try {
      if (options.fixture) {
        await installFixture(env.manager, env.root, options.fixture);
        await env.manager.configure("sample", { enabled: true });
      }
      if (options.keepTail !== undefined) {
        await env.manager.configure("compact-vault", { enabled: true, config: { keepTail: options.keepTail } });
      }
      const providers = new ProviderRegistry();
      providers.register(makeStubProvider("test-stub"));
      const app = await buildServer({
        core: { request: async () => ({}), configureSession: async () => undefined } as never,
        sessions: env.sessions,
        agent: { isRunning: () => false } as never,
        events: env.events,
        providers,
        pricing: env.pricing,
        extensions: env.manager,
        vaultService: env.vaultService,
        ...(options.compactor ? { compactor: new Compactor(env.sessions, env.client) } : {}),
      });
      try {
        return await fn(env, app);
      } finally {
        await app.close();
      }
    } finally {
      await env.manager.close();
    }
  }

  it("routes /compact through the vault service when the extension is enabled and serves readVaultFile via the host", async () => {
    await withVaultApp({
      fixture: { permissions: ["context:read", "tools:register"], entry: STORAGE_ENTRY },
      keepTail: 2,
    }, async ({ events, session, manager }, app) => {
      const published: AppEvent[] = [];
      events.on("event", (event: AppEvent) => published.push(event));
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "overview" } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { changed: boolean; mode: string; uptoIndex?: number };
      expect(body.changed).toBe(true);
      expect(body.mode).toBe("vault");
      // 扩展配置 keepTail=2 生效：24 条消息 → uptoIndex 22
      expect(body.uptoIndex).toBe(22);
      // 手动压缩开始即发布 compacting 事件（UI 即时反馈）
      expect(published.some((event) => event.type === "context.compacting" && (event.payload as { mode?: string }).mode === "vault")).toBe(true);

      // host → server context.readVaultFile 往返：读到归档索引
      const toolResult = await manager.invokeTool("ext__sample__vread", { sessionId: session.id, path: "index.json" }, session.id);
      expect(toolResult.content).toContain("goals");
      // 路径逃逸被拒
      await expect(manager.invokeTool("ext__sample__vread", { sessionId: session.id, path: "../ledger.json" }, session.id)).rejects.toThrow(/escapes|relative/);
    });
  }, 25_000);

  it("falls back to the default compactor when the extension is disabled", async () => {
    await withVaultApp({ compactor: true }, async ({ sessions, session }, app) => {
      // 扩展未启用（默认）：/compact 走默认 Compactor（overview），不创建归档目录
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "overview" } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { changed: boolean; mode: string };
      expect(body.changed).toBe(true);
      expect(body.mode).toBe("overview");
      const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
      expect(ledger.compacted?.mode).toBe("overview");
      const compactDir = path.join(sessions.contextRoot(session.id), "compact");
      await expect(readdir(compactDir)).rejects.toThrow();
    });
  }, 25_000);

  it("serves the /compact slash command via the vault service even without a compactor", async () => {
    await withVaultApp({ rows: 12, withAssistant: false, keepTail: 2 }, async ({ events, sessions, session }, app) => {
      const published: AppEvent[] = [];
      events.on("event", (event: AppEvent) => published.push(event));
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "/compact" } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ compacted: boolean }>().compacted).toBe(true);
      const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
      expect(ledger.compacted?.mode).toBe("vault");
      expect(published.some((event) => event.type === "context.compacting")).toBe(true);
      expect(published.some((event) => event.type === "context.compacted" && (event.payload as { mode?: string }).mode === "vault")).toBe(true);
    });
  }, 25_000);

  it("routes the 85% force compaction through the vault service when the extension is enabled", async () => {
    const env = await makeVaultEnv(0);
    const published: AppEvent[] = [];
    env.events.on("event", (event: AppEvent) => published.push(event));
    try {
      await env.manager.configure("compact-vault", { enabled: true, config: { keepTail: 1 } });
      const requests: StreamChatRequest[] = [];
      const providers = new ProviderRegistry();
      const provider: Provider = {
        name: "test-stub",
        async *streamChat(request) {
          requests.push(request);
          yield { type: "done", stopReason: "end_turn" };
        },
      };
      providers.register(provider);
      const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
      const tinyWindow = () => ({ contextWindow: 100, capabilities: { thinking: ["disabled"], effort: [] } }) as never;
      // compactor 缺失（第 13 参 undefined）：强制压缩由 vault 单独兜底
      const runner = new AgentRunner(env.sessions, providers, core, env.events, env.pricing, undefined, "zh-CN", 50, tinyWindow, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, env.manager);
      runner.setVaultService(env.vaultService);
      const session = await env.sessions.create({ cwd: env.root, provider: "test-stub", model: "tiny" });
      await env.sessions.appendMessage(session.id, "user", [{ type: "text", text: "很早的消息，".repeat(30) }]);
      await env.sessions.appendMessage(session.id, "assistant", [{ type: "text", text: "很早的回复，".repeat(30) }]);

      await runner.run(session.id, "新的问题，".repeat(30));

      const compacting = published.filter((event) => event.type === "context.compacting");
      expect(compacting).toHaveLength(1);
      expect(compacting[0]?.payload).toMatchObject({ forced: true, mode: "vault" });
      const compacted = published.filter((event) => event.type === "context.compacted");
      expect(compacted).toHaveLength(1);
      expect(compacted[0]?.payload).toMatchObject({ forced: true, mode: "vault" });
      // 归档落盘 + 账本标记 vault
      const compactDir = path.join(env.sessions.contextRoot(session.id), "compact");
      const segments = await readdir(path.join(compactDir, "segments"));
      expect(segments.length).toBeGreaterThan(0);
      const ledger = await new ContextManager(env.sessions.contextRoot(session.id)).load();
      expect(ledger.compacted?.mode).toBe("vault");
      // provider 收到的重建视图首条是目录索引（而非原始消息）
      expect(requests.at(-1)?.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("recall_memory") });
    } finally {
      await env.manager.close();
    }
  }, 25_000);
});

describe("compact-vault thinking-model fallback and maxTokens", () => {
  it("思考模型优先适配：正文只走 thinking 通道时整理仍成功（直连兜底收集）", async () => {
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* (request) {
      const last = request.messages.at(-1);
      const prompt = last?.content.find((block) => block.type === "text")?.text ?? "";
      if (prompt.includes("对话转录")) {
        yield { type: "thinking_delta", text: "KEY: goals\nTITLE: 目标\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nDESC: 采用方案 Y" };
      } else {
        yield { type: "thinking_delta", text: "[归档索引] 早前共 10 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。\n- 目标 (key=goals)：用户要求实现 X" };
      }
      yield { type: "done", stopReason: "end_turn" };
    }));
    const client = new FastModelClient(providers, { provider: "test-stub", model: "fast-m" });
    const { sessions, sessionId, result } = await compactSession(plainMessages(12), { fastModel: client, providers });
    expect(result.changed).toBe(true);
    expect(result.mode).toBe("vault");
    expect(result.summary).toContain("key=goals");
    const ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.summary).toContain("key=goals");
  });

  it("有上限时优先走 FastModelClient，空返回自动直连兜底", async () => {
    const calls: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* (request) {
      calls.push(request);
      const last = request.messages.at(-1);
      const prompt = last?.content.find((block) => block.type === "text")?.text ?? "";
      // 第一次调用（FastModelClient）：只发 thinking → complete 抛「快速模型返回为空」；
      // 第二次（completeVault 直连兜底）：thinking 通道给正文
      if (calls.length === 1) {
        yield { type: "thinking_delta", text: "思考中…" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      if (prompt.includes("对话转录")) {
        yield { type: "thinking_delta", text: "KEY: goals\nTITLE: 目标\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nDESC: 采用方案 Y" };
      } else {
        yield { type: "thinking_delta", text: "[归档索引] 早前共 10 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。\n- 目标 (key=goals)：用户要求实现 X" };
      }
      yield { type: "done", stopReason: "end_turn" };
    }));
    const client = new FastModelClient(providers, { provider: "test-stub", model: "fast-m" });
    const { result } = await compactSession(plainMessages(12), {
      fastModel: client,
      providers,
      // 扩展配置：用户手动设置输出上限（默认不限制）
      getConfig: () => ({ maxTokens: 4096 }),
    });
    expect(result.changed).toBe(true);
    // 直连兜底请求带配置的 maxTokens（FastModelClient 调用也带）
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.at(-1)?.maxTokens).toBe(4096);
  });

  it("maxTokens 缺省不限制：直连请求不携带输出上限", async () => {
    const calls: StreamChatRequest[] = [];
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("test-stub", async function* (request) {
      calls.push(request);
      const last = request.messages.at(-1);
      const prompt = last?.content.find((block) => block.type === "text")?.text ?? "";
      if (prompt.includes("对话转录")) {
        yield { type: "text_delta", text: "KEY: goals\nTITLE: 目标\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nDESC: 采用方案 Y" };
      } else {
        yield { type: "text_delta", text: "[归档索引] 早前共 10 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。\n- 目标 (key=goals)：用户要求实现 X" };
      }
      yield { type: "done", stopReason: "end_turn" };
    }));
    const client = new FastModelClient(providers, { provider: "test-stub", model: "fast-m" });
    const { result } = await compactSession(plainMessages(12), { fastModel: client, providers });
    expect(result.changed).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.maxTokens === undefined)).toBe(true);
  });
});
