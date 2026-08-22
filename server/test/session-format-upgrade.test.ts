import path from "node:path";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage, TextContent } from "../src/sessions/types.js";
import { deriveMessageItemId, upgradeResponsesReplayFields } from "../src/providers/responses-replay.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";
import {
  isSessionUpgrading, listFormatUpgrades, registerFormatUpgrade,
  upgradeAllSessions, upgradeResponsesTextSignatures, upgradeSessionFormat,
} from "../src/extensions/session-format-upgrade.js";
import { tempRoot } from "./helpers/temp-roots.js";

const sse = (events: Array<Record<string, unknown>>): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const completedFetch = (bodies: Array<Record<string, unknown>>) =>
  (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(sse([{ type: "response.completed", response: { status: "completed", output: [] } }]), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;

const request = (messages: StreamChatRequest["messages"]): StreamChatRequest =>
  ({ model: "deepseek-v4-pro", system: "system", messages, tools: [], signal: new AbortController().signal });

async function drain(iterable: AsyncIterable<ProviderEvent>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

/** 旧格式 assistant 消息（thinking 无 signature、tool_call 无 itemId）。 */
function legacyAssistant(id: string): ChatMessage {
  return {
    id, role: "assistant", createdAt: "2026-01-01T00:00:00.000Z",
    content: [
      { type: "thinking", text: "旧思维链", provider: "openai-responses" },
      { type: "text", text: "正文" },
      { type: "tool_call", id: "call_old1", name: "bash", input: { cmd: "ls" } },
    ],
  };
}

describe("upgradeResponsesReplayFields（旧会话 → 新格式，幂等）", () => {
  it("旧 thinking/tool_call 块补 signature/itemId，Anthropic 块不碰", () => {
    const messages: ChatMessage[] = [
      legacyAssistant("a1"),
      { ...legacyAssistant("a2"), content: [{ type: "thinking", text: "Anthropic 思维", provider: "anthropic" }] },
    ];
    const { messages: upgraded, changed } = upgradeResponsesReplayFields(messages);
    expect(changed).toBe(2); // a1 的 thinking + tool_call；a2 的 Anthropic 块不碰
    const first = upgraded[0]!;
    const signature = JSON.parse((first.content[0] as { signature: string }).signature) as Record<string, unknown>;
    expect(signature).toMatchObject({ type: "reasoning", content: [{ type: "reasoning_text", text: "旧思维链" }] });
    expect(String(signature.id)).toMatch(/^rs_/);
    expect((first.content[2] as { itemId?: string }).itemId).toBe("fc_call_old1");
    expect((upgraded[1]!.content[0] as { signature?: string }).signature).toBeUndefined();
    // 幂等：二次执行无变更
    const second = upgradeResponsesReplayFields(upgraded);
    expect(second.changed).toBe(0);
  });

  it("升级固化字段与回放端派生路径产出完全一致（请求体不变）", async () => {
    const messages: StreamChatRequest["messages"] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-01-01T00:00:00.000Z" },
      legacyAssistant("a1"),
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call_old1", content: "A", isError: false }], createdAt: "2026-01-01T00:00:02.000Z" },
    ];
    // 未升级 → 回放回落 thinking 块文本
    const legacyBodies: Array<Record<string, unknown>> = [];
    await drain(new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: completedFetch(legacyBodies) }).streamChat(request(messages)));
    // 升级后 → 回放从固化的 signature 提取同样文本，请求体保持一致
    const upgradedBodies: Array<Record<string, unknown>> = [];
    const upgraded = upgradeResponsesReplayFields(messages).messages as StreamChatRequest["messages"];
    await drain(new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: completedFetch(upgradedBodies) }).streamChat(request(upgraded)));
    expect(upgradedBodies[0]?.input).toEqual(legacyBodies[0]?.input);
  });
});

describe("upgradeResponsesTextSignatures（旧会话文本块 → v1 textSignature，幂等）", () => {
  it("为 legacy 文本块固化确定性 v1 textSignature（msg_<24 hex>），非文本块不碰", () => {
    const messages: ChatMessage[] = [
      legacyAssistant("a1"), // content: [thinking, text "正文", tool_call]
      {
        id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z",
        content: [
          { type: "thinking", text: "思考", provider: "openai-responses" },
          { type: "text", text: "第一段" },
          { type: "tool_call", id: "call_2", name: "bash", input: { cmd: "pwd" } },
          { type: "text", text: "第二段" },
        ],
      },
    ];
    const { messages: upgraded, changed } = upgradeResponsesTextSignatures(messages);
    expect(changed).toBe(3); // a1 的 "正文" + a2 的两段文本
    const first = upgraded[0]!;
    const sig1 = JSON.parse((first.content[1] as TextContent).textSignature!) as { v: number; id: string };
    expect(sig1).toEqual({ v: 1, id: deriveMessageItemId("a1:0") });
    expect(sig1.id).toMatch(/^msg_[0-9a-f]{24}$/);
    // thinking / tool_call 块不碰
    expect((first.content[0] as { signature?: string }).signature).toBeUndefined();
    expect((first.content[2] as { itemId?: string }).itemId).toBeUndefined();
    // ordinal 只数文本块：a2 第二段文本派生自 "a2:1"
    const second = upgraded[1]!;
    const sig2a = JSON.parse((second.content[1] as TextContent).textSignature!) as { id: string };
    const sig2b = JSON.parse((second.content[3] as TextContent).textSignature!) as { id: string };
    expect(sig2a.id).toBe(deriveMessageItemId("a2:0"));
    expect(sig2b.id).toBe(deriveMessageItemId("a2:1"));
  });

  it("空文本块（text.trim() === \"\"）不补签名", () => {
    const messages: ChatMessage[] = [{
      id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z",
      content: [{ type: "text", text: "   " }],
    }];
    const { messages: upgraded, changed } = upgradeResponsesTextSignatures(messages);
    expect(changed).toBe(0);
    expect((upgraded[0]!.content[0] as TextContent).textSignature).toBeUndefined();
  });

  it("幂等：二次执行 changed === 0", () => {
    const messages: ChatMessage[] = [legacyAssistant("a1")];
    const first = upgradeResponsesTextSignatures(messages);
    expect(first.changed).toBe(1);
    const second = upgradeResponsesTextSignatures(first.messages);
    expect(second.changed).toBe(0);
  });
});

describe("session-format-upgrade 扩展框架", () => {
  // tempRoot 返回 Promise 且目录随 afterEach 清理：每个用例独立建 root/store
  const newStore = async (): Promise<{ root: string; store: SessionStore }> => {
    const root = await tempRoot("owc-fmt-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    return { root, store };
  };

  it("内置 responses-replay-fields / responses-text-signature 步骤已注册，新步骤可注册", () => {
    expect(listFormatUpgrades().some((s) => s.id === "responses-replay-fields")).toBe(true);
    expect(listFormatUpgrades().some((s) => s.id === "responses-text-signature")).toBe(true);
    registerFormatUpgrade({ id: "future-step", scope: "messages", description: "future", run: async () => ({ changed: 0 }) });
    expect(listFormatUpgrades().some((s) => s.id === "future-step")).toBe(true);
  });

  it("单会话升级：备份生成、锁释放、重复触发幂等、并发拒绝、运行中跳过", async () => {
    const { store } = await newStore();
    const meta = await store.create({ cwd: "/tmp", title: "legacy" });
    await store.appendMessage(meta.id, "assistant", legacyAssistant("a1").content, { runId: "r1" });

    const result = await upgradeSessionFormat(store, meta.id, "responses-replay-fields");
    expect(result.changed).toBe(2);
    expect(result.backups).toHaveLength(1);
    expect(isSessionUpgrading(meta.id)).toBe(false);

    // 幂等：二次执行无变更、不写盘
    const again = await upgradeSessionFormat(store, meta.id, "responses-replay-fields");
    expect(again.changed).toBe(0);
    expect(again.backups).toHaveLength(0);

    // 并发触发拒绝（慢步骤保证第一个调用挂起期间锁仍持有）
    registerFormatUpgrade({
      id: "slow-step", scope: "messages", description: "slow",
      run: async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return { changed: 0 }; },
    });
    const running = upgradeSessionFormat(store, meta.id, "slow-step");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(upgradeSessionFormat(store, meta.id, "slow-step")).rejects.toThrow(/already in progress/);
    await running;

    // 全部升级：运行中的会话跳过
    const all = await upgradeAllSessions(store, (id) => id === meta.id);
    expect(all.skipped).toContain(meta.id);
  });

  it("transformMessages 落盘：备份存在、原子写回、缓存失效", async () => {
    const { root, store } = await newStore();
    const meta = await store.create({ cwd: "/tmp", title: "legacy2" });
    await store.appendMessage(meta.id, "assistant", legacyAssistant("a2").content, { runId: "r1" });
    const result = await store.transformMessages(meta.id, upgradeResponsesReplayFields);
    expect(result.changed).toBe(2);
    expect(result.backup).toBeTruthy();

    const sessionDir = path.join(root, "sessions", meta.id);
    await expect(stat(path.join(sessionDir, result.backup!))).resolves.toBeTruthy();
    const raw = await readFile(path.join(sessionDir, "messages.jsonl"), "utf8");
    const parsed = JSON.parse(raw.split("\n").filter(Boolean)[0]!) as ChatMessage;
    expect(typeof (parsed.content[0] as { signature?: string }).signature).toBe("string");
    expect((parsed.content[2] as { itemId?: string }).itemId).toBe("fc_call_old1");
    // 缓存失效后重新读取为新格式
    const detail = await store.get(meta.id);
    expect(typeof (detail!.messages[0]!.content[0] as { signature?: string }).signature).toBe("string");
  });

  it("升级备份清理：仅保留最近 3 份 messages.jsonl.upgrade-*", async () => {
    const { root, store } = await newStore();
    const meta = await store.create({ cwd: "/tmp", title: "backup-prune" });
    await store.appendMessage(meta.id, "assistant", legacyAssistant("a3").content, { runId: "r1" });
    const sessionDir = path.join(root, "sessions", meta.id);
    // 预置 3 份更早的旧备份（模拟历史升级），本次再触发一次升级 → 共 4 份，最旧 1 份被清
    for (const ts of [1000, 2000, 3000]) {
      await writeFile(path.join(sessionDir, `messages.jsonl.upgrade-${ts}`), "old");
    }
    const touch = async (): Promise<number> => {
      const result = await store.transformMessages(meta.id, (messages) => ({ messages: [...messages], changed: 1 }));
      return result.changed;
    };
    await expect(touch()).resolves.toBe(1);
    const backups = (await readdir(sessionDir)).filter((name) => name.startsWith("messages.jsonl.upgrade-")).sort();
    expect(backups).toHaveLength(3);
    // 最旧预置份被删，最近 3 份（2 旧 + 1 新）保留
    expect(backups).not.toContain("messages.jsonl.upgrade-1000");
    expect(backups).toContain("messages.jsonl.upgrade-2000");
    expect(backups).toContain("messages.jsonl.upgrade-3000");
    expect(backups.some((name) => name !== "messages.jsonl.upgrade-2000" && name !== "messages.jsonl.upgrade-3000")).toBe(true);
  });
});
