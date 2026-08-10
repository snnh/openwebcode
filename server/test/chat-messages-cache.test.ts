import { appendFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatSessionStore } from "../src/chat/chat-session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

// ChatSessionStore.readMessages 整表缓存的等价性测试（镜像 session-messages-cache.test.ts
// 的纪律）：缓存路径的读取必须与全新实例（空缓存、纯磁盘读取）深度一致，
// 覆盖追加穿透、外部写入失效、损坏尾行、分页与派生标题。

function storeAt(root: string): ChatSessionStore {
  return new ChatSessionStore(root);
}

function messagesPathOf(root: string, sessionId: string): string {
  return path.join(root, "chat-sessions", sessionId, "messages.jsonl");
}

async function seedMessages(store: ChatSessionStore, sessionId: string, count: number): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(await store.appendMessage(sessionId, "user", [{ type: "text", text: `message-${i}` }]));
  }
  return messages;
}

describe("chat session messages cache (readMessages whole-list cache)", () => {
  it("cached getMessages equals fresh read after seeding", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 20);

    const first = await store.getMessages(session.id); // 冷加载，建立缓存
    const second = await store.getMessages(session.id); // 缓存命中
    const fresh = await storeAt(root).getMessages(session.id);
    expect(first).toEqual(fresh);
    expect(second).toEqual(fresh);
    expect(second).toHaveLength(20);
  });

  it("append-through keeps cached getMessages equal to fresh read", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 10);
    await store.getMessages(session.id); // 建立缓存

    const assistant = await store.appendMessage(session.id, "assistant", [{ type: "text", text: "reply" }]);
    const cached = await store.getMessages(session.id);
    const fresh = await storeAt(root).getMessages(session.id);
    expect(cached).toEqual(fresh);
    expect(cached).toHaveLength(11);
    expect(cached.at(-1)!.id).toBe(assistant.id);
    expect(cached.at(-1)!.parentId).toBe(cached.at(-2)!.id);
  });

  it("external append (bypassing ChatSessionStore) invalidates the cache", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await store.getMessages(session.id); // 建立缓存

    const external: ChatMessage = {
      id: "00000000-0000-4000-8000-0000000000aa",
      role: "user",
      content: [{ type: "text", text: "external" }],
      createdAt: new Date().toISOString(),
    };
    await appendFile(messagesPathOf(root, session.id), `${JSON.stringify(external)}\n`, "utf8");

    const after = await store.getMessages(session.id);
    const fresh = await storeAt(root).getMessages(session.id);
    expect(after).toEqual(fresh);
    expect(after).toHaveLength(6);
    // 外部消息无 parentId：读取派生链接到前一条
    expect(after.at(-1)!.parentId).toBe(after.at(-2)!.id);
  });

  it("corrupt tail is skipped consistently across cache hits and fresh reads", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await appendFile(messagesPathOf(root, session.id), "{corrupt-tail", "utf8");

    const cached = await store.getMessages(session.id);
    const again = await store.getMessages(session.id);
    const fresh = await storeAt(root).getMessages(session.id);
    expect(cached).toEqual(fresh);
    expect(again).toEqual(fresh);
    expect(cached).toHaveLength(5);
  });

  it("mutating the returned array does not poison the cache", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    const first = await store.getMessages(session.id);
    first.push({ id: "fake", role: "user", content: [], createdAt: "x" } as ChatMessage);
    first.splice(0, 2);

    const second = await store.getMessages(session.id);
    expect(second).toHaveLength(5);
    expect(second).toEqual(await storeAt(root).getMessages(session.id));
  });

  it("getMessagesBefore pages correctly over the cache", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    const seeded = await seedMessages(store, session.id, 10);
    await store.getMessages(session.id); // 建立缓存

    const page = await store.getMessagesBefore(session.id, seeded[8]!.id, 3);
    expect(page.map((message) => message.id)).toEqual([seeded[5]!.id, seeded[6]!.id, seeded[7]!.id]);
    // 再翻一页（缓存路径）与全新实例一致
    const earlier = await store.getMessagesBefore(session.id, seeded[5]!.id, 3);
    const fresh = await storeAt(root).getMessagesBefore(session.id, seeded[5]!.id, 3);
    expect(earlier).toEqual(fresh);
    expect(earlier.map((message) => message.id)).toEqual([seeded[2]!.id, seeded[3]!.id, seeded[4]!.id]);
  });

  it("rename with empty title derives from cached messages", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "hello derived title" }]);
    await store.getMessages(session.id); // 建立缓存

    const renamed = await store.rename(session.id, "   ");
    expect(renamed.title).toBe("hello derived title");
  });

  it("delete invalidates the cache", async () => {
    const root = await tempRoot("owc-chatcache-");
    const store = storeAt(root);
    await store.initialize();
    const session = await store.create({ provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await store.getMessages(session.id); // 建立缓存

    await store.delete(session.id);
    expect(await store.getMessages(session.id)).toEqual([]);
  });
});
