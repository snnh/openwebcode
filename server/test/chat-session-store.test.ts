import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { ChatAssistantStore } from "../src/chat/chat-assistant-store.js";
import { ChatConfigService } from "../src/chat/chat-config.js";
import { ChatPythonEnv } from "../src/chat/chat-python-env.js";
import { ChatRunner } from "../src/chat/chat-runner.js";
import { ChatSessionStore } from "../src/chat/chat-session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const IMAGE = { mediaType: "image/png", data: "aGVsbG8=" };

async function storeAt(): Promise<ChatSessionStore> {
  const store = new ChatSessionStore(await tempRoot("owc-chat-store-"));
  await store.initialize();
  return store;
}

/** 捕获 provider 实际收到的消息，回复一段固定文本。 */
function captureProvider(captured: StreamChatRequest[], onStream?: () => void): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register({
    name: "stub",
    async *streamChat(request: StreamChatRequest): AsyncIterable<ProviderEvent> {
      captured.push(request);
      onStream?.();
      yield { type: "text_delta", text: "ok" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 };
      yield { type: "done", stopReason: "end_turn" };
    },
  });
  return providers;
}

async function runnerFor(root: string, providers: ProviderRegistry): Promise<ChatRunner> {
  return new ChatRunner(
    new ChatSessionStore(root),
    providers,
    new ChatPythonEnv(path.join(root, "python"), []),
    undefined,
    undefined,
    new ChatConfigService(path.join(root, "chat.json")),
    undefined,
    new ChatAssistantStore(path.join(root, "chat-assistants.json")),
    () => 4,
  );
}

describe("chat 会话存储：活动分支投影与分页", () => {
  it("只投影当前分支；分页按 before 向前取且 hasMore 正确，跨分支/未知游标返回空页", async () => {
    const store = await storeAt();
    const session = await store.create({ provider: "stub", model: "stub" });
    const question = await store.appendMessage(session.id, "user", [{ type: "text", text: "问题" }]);
    const firstAnswer = await store.appendMessage(session.id, "assistant", [{ type: "text", text: "旧回答" }]);
    // 重新生成：回到 user 之后长出新分支，旧 assistant 保留在 JSONL
    await store.checkout(session.id, question.id);
    const newAnswer = await store.appendMessage(session.id, "assistant", [{ type: "text", text: "新回答" }]);
    for (let index = 0; index < 6; index += 1) {
      await store.appendMessage(session.id, "user", [{ type: "text", text: `追问 ${index}` }]);
      await store.appendMessage(session.id, "assistant", [{ type: "text", text: `回复 ${index}` }]);
    }

    const active = await store.getActiveMessages(session.id);
    expect(active.map((message) => message.id)).not.toContain(firstAnswer.id);
    expect(active.map((message) => message.id)).toContain(newAnswer.id);
    expect(active.at(-2)?.content).toEqual([{ type: "text", text: "追问 5" }]);

    const tail = await store.getActiveMessagesPage(session.id, 4);
    expect(tail.messages).toEqual(active.slice(-4));
    expect(tail.hasMore).toBe(true);
    const older = await store.getActiveMessagesPage(session.id, 4, tail.messages[0]!.id);
    expect(older.messages).toEqual(active.slice(-8, -4));
    const firstPage = await store.getActiveMessagesPage(session.id, 50);
    expect([firstPage.messages, firstPage.hasMore]).toEqual([active, false]);
    expect(await store.getActiveMessagesPage(session.id, 4, firstAnswer.id)).toEqual({ messages: [], hasMore: false });
  });
});

describe("chat runner 上下文与运行起点", () => {
  it("纯图片消息只把已落盘 user 消息送一次；started 在首个 await 之前同步触发", async () => {
    const root = await tempRoot("owc-chat-runner-");
    const sessions = new ChatSessionStore(root);
    await sessions.initialize();
    const captured: StreamChatRequest[] = [];
    const runner = await runnerFor(root, captureProvider(captured));
    const session = await sessions.create({ provider: "stub", model: "stub" });
    // 纯图片消息：HTTP 层已落盘 text+image（text 为空），runner 不得再补一份
    await sessions.appendMessage(session.id, "user", [
      { type: "text", text: "" },
      { type: "image", ...IMAGE },
    ]);

    let streamed = false;
    let startedSynchronously = false;
    const meta = (await sessions.get(session.id))!;
    const startedAt = Date.now();
    const pending = runner.runChatMessage({
      sessionId: session.id,
      userMessage: "",
      images: [IMAGE],
      meta,
      signal: new AbortController().signal,
      onStarted: () => {
        // 同步回调：调用返回前就已触发，且流式尚未开始
        expect(Date.now() - startedAt).toBeLessThan(50);
        expect(streamed).toBe(false);
        startedSynchronously = true;
      },
      onDelta: () => { streamed = true; },
    });
    expect(startedSynchronously).toBe(true);
    await pending;

    const userMessages = captured.at(-1)!.messages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect(streamed).toBe(true);
  });
});
