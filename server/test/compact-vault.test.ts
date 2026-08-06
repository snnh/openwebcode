import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ContextManager } from "../src/context/context-manager.js";
import { CompactVaultService, chunkMessages, loadVaultIndex, parseSectionList, renderChunk } from "../src/extensions/compact-vault.js";
import { parseVaultIndexJson, recallMemory, reinjectVaultIndex, type VaultHostApi } from "../src/extensions/compact-vault-host.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionPermission } from "../src/extensions/types.js";
import { FastModelClient } from "../src/fast-model.js";
import { ProviderRegistry } from "../src/providers/provider.js";
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

/** 快速模型 stub：Pass 1 按块输出目录条目，Pass 2 输出目录索引；可注入指令段。 */
function vaultFastModel(extraIndexSections = ""): { client: FastModelClient; calls: string[] } {
  const calls: string[] = [];
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", async function* (request) {
    const last = request.messages.at(-1);
    const prompt = last?.content.find((block) => block.type === "text")?.text ?? "";
    calls.push(prompt.slice(0, 120));
    if (prompt.includes("对话转录")) {
      const file = /转录文件：(\S+)/.exec(prompt)?.[1] ?? "segments/seg-001.md";
      yield { type: "text_delta", text: `KEY: goals\nTITLE: 目标\nFILES: ${file}\nDESC: 用户要求实现 X\n---\nKEY: impl\nTITLE: 实现方案\nFILES: ${file}\nDESC: 采用方案 Y` };
    } else {
      yield { type: "text_delta", text: `[归档索引] 早前共 ${prompt.match(/待压缩对话共 (\d+) 条消息/)?.[1] ?? "?"} 条消息已归档至会话 compact/ 目录。需要细节时调用 recall_memory(keys=[...]) 按 key 召回完整内容。\n- 目标 (key=goals)：用户要求实现 X\n- 实现方案 (key=impl)：采用方案 Y${extraIndexSections}` };
    }
    yield { type: "usage", inputTokens: 10, outputTokens: 10, cacheRead: 0, cacheWrite: 0 };
    yield { type: "done", stopReason: "end_turn" };
  }));
  return { client: new FastModelClient(providers, { provider: "test-stub", model: "fast-m" }), calls };
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

async function compactSession(messages: ChatMessage[], options: { chunkSize?: number; keepTail?: number; fastModel?: FastModelClient } = {}) {
  const { sessions, sessionId } = await makeSession(messages);
  const { client } = options.fastModel ? { client: options.fastModel } : vaultFastModel();
  const service = new CompactVaultService(sessions, client);
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
    const messages = Array.from({ length: 12 }, (_, index) => textMessage(`m${index}`, "user", `x${index}`));
    const { sessionId, service } = await compactSession(messages);
    const second = await service.compact(sessionId);
    expect(second.changed).toBe(false);
    expect(second.reason).toContain("没有新的可压缩区段");
  });

  it("requires a configured fast model", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => textMessage(`m${index}`, "user", `x${index}`));
    const { sessions, sessionId } = await makeSession(messages);
    const service = new CompactVaultService(sessions, new FastModelClient(new ProviderRegistry()));
    await expect(service.compact(sessionId)).rejects.toThrow(/快速模型未配置/);
  });

  it("accumulates user instructions across compactions", async () => {
    const { client: firstClient } = vaultFastModel("\n用户明确指令：\n- 不要删除文档");
    const messages = Array.from({ length: 12 }, (_, index) => textMessage(`m${index}`, "user", `x${index}`));
    const { sessions, sessionId } = await makeSession(messages);
    const service = new CompactVaultService(sessions, firstClient);
    await service.compact(sessionId);
    let ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.instructions).toEqual(["不要删除文档"]);

    // 追加消息后再压缩：旧指令跨段保留
    const { client: secondClient } = vaultFastModel("\n用户明确指令：\n- 保持接口不变");
    for (let index = 0; index < 4; index += 1) await sessions.appendMessage(sessionId, "user", [{ type: "text", text: `more ${index}` }]);
    const secondService = new CompactVaultService(sessions, secondClient);
    await secondService.compact(sessionId);
    ledger = await new ContextManager(sessions.contextRoot(sessionId)).load();
    expect(ledger.compacted?.instructions).toEqual(["不要删除文档", "保持接口不变"]);
  });
});

describe("CompactVaultService.readFile", () => {
  it("reads files inside compact/ and rejects escapes", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => textMessage(`m${index}`, "user", `x${index}`));
    const { sessionId, service } = await compactSession(messages);
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

  it("routes /compact through the vault service when the extension is enabled and serves readVaultFile via the host", async () => {
    const root = await tempRoot("owc-vaultapp-");
    const events = new EventBus();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "m1" });
    for (let index = 0; index < 12; index += 1) {
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: `需求 ${index}` }]);
      await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: `回答 ${index}` }]);
    }
    const { client } = vaultFastModel();
    const vaultService = new CompactVaultService(sessions, client);
    const manager = new ExtensionManager(path.join(root, "data"), events, { sessions, vaultService });
    await manager.initialize();
    try {
      await installFixture(manager, root, { permissions: ["context:read", "tools:register"], entry: STORAGE_ENTRY });
      await manager.configure("compact-vault", { enabled: true, config: { keepTail: 2 } });
      await manager.configure("sample", { enabled: true });

      const providers = new ProviderRegistry();
      providers.register(makeStubProvider("test-stub"));
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      const app = await buildServer({
        core: { request: async () => ({}), configureSession: async () => undefined } as never,
        sessions,
        agent: { isRunning: () => false } as never,
        events,
        providers,
        pricing,
        extensions: manager,
        vaultService,
      });
      try {
        const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/compact`, payload: { mode: "overview" } });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { changed: boolean; mode: string; uptoIndex?: number };
        expect(body.changed).toBe(true);
        expect(body.mode).toBe("vault");
        // 扩展配置 keepTail=2 生效：24 条消息 → uptoIndex 22
        expect(body.uptoIndex).toBe(22);

        // host → server context.readVaultFile 往返：读到归档索引
        const toolResult = await manager.invokeTool("ext__sample__vread", { sessionId: session.id, path: "index.json" }, session.id);
        expect(toolResult.content).toContain("goals");
        // 路径逃逸被拒
        await expect(manager.invokeTool("ext__sample__vread", { sessionId: session.id, path: "../ledger.json" }, session.id)).rejects.toThrow(/escapes|relative/);
      } finally {
        await app.close();
      }
    } finally {
      await manager.close();
    }
  }, 25_000);

  it("falls back to the default compactor when the extension is disabled", async () => {
    const root = await tempRoot("owc-vaultoff-");
    const events = new EventBus();
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "test-stub", model: "m1" });
    for (let index = 0; index < 12; index += 1) {
      await sessions.appendMessage(session.id, "user", [{ type: "text", text: `需求 ${index}` }]);
      await sessions.appendMessage(session.id, "assistant", [{ type: "text", text: `回答 ${index}` }]);
    }
    const { client } = vaultFastModel();
    const vaultService = new CompactVaultService(sessions, client);
    const manager = new ExtensionManager(path.join(root, "data"), events, { sessions, vaultService });
    await manager.initialize();
    try {
      const providers = new ProviderRegistry();
      providers.register(makeStubProvider("test-stub"));
      const pricing = new PricingCatalog(path.join(root, "pricing.json"));
      await pricing.initialize();
      const { Compactor } = await import("../src/context/compactor.js");
      const compactor = new Compactor(sessions, client);
      const app = await buildServer({
        core: { request: async () => ({}), configureSession: async () => undefined } as never,
        sessions,
        agent: { isRunning: () => false } as never,
        events,
        providers,
        pricing,
        extensions: manager,
        vaultService,
        compactor,
      });
      try {
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
      } finally {
        await app.close();
      }
    } finally {
      await manager.close();
    }
  }, 25_000);
});
