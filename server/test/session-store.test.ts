import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("SessionStore.appendMessage 并发串行化", () => {
  it("并发追加大消息：JSONL 行数与完整性保持（无交织坏行）", async () => {
    const root = await tempRoot("owc-session-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });

    // 1MB 级消息并发追加：底层多次 write，未串行化时最易交织坏行
    const big = "x".repeat(1024 * 1024);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.appendMessage(session.id, "user", [{ type: "text", text: `${index}:${big}` }])),
    );

    const raw = await readFile(path.join(root, "sessions", session.id, "messages.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(8);
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { content: Array<{ text: string }> };
      const match = /^(\d):x+$/.exec(parsed.content[0]!.text);
      expect(match, "每行必须是完整 JSON 且内容未被其他消息交织").toBeTruthy();
      seen.add(match![1]!);
    }
    expect(seen.size).toBe(8);
  });

  it("串行化链不阻断后续追加：前一条失败后一条仍正常落盘", async () => {
    const root = await tempRoot("owc-session-store-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });

    // 对不存在的会话追加失败（readMeta 抛错），同会话后续追加不受影响
    await expect(store.appendMessage("missing-session", "user", [{ type: "text", text: "x" }])).rejects.toThrow();
    const message = await store.appendMessage(session.id, "user", [{ type: "text", text: "正常消息" }]);
    expect(message.content).toEqual([{ type: "text", text: "正常消息" }]);
    const detail = await store.get(session.id);
    expect(detail?.messages).toHaveLength(1);
  });
});

describe("SessionStore.updateSandboxMode", () => {
  it("sandboxMode undefined 保留现值；显式值写入；jobobject 删除；空 setupScript 删除", async () => {
    const root = await tempRoot("owc-sandbox-mode-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });

    await store.updateSandboxMode(session.id, "bubblewrap", undefined);
    // sandboxMode 缺省（undefined）：保留现值；setupScript 照常写入
    const preserved = await store.updateSandboxMode(session.id, undefined, "echo hi");
    expect(preserved.sandboxMode).toBe("bubblewrap");
    expect(preserved.setupScript).toBe("echo hi");
    // 显式值写入；setupScript 缺省/空 → 从元数据删除
    const off = await store.updateSandboxMode(session.id, "off", undefined);
    expect(off.sandboxMode).toBe("off");
    expect(off).not.toHaveProperty("setupScript");
    // 显式 jobobject（平台缺省档）归一化为删除属性
    const cleared = await store.updateSandboxMode(session.id, "jobobject", undefined);
    expect(cleared).not.toHaveProperty("sandboxMode");
    // 落盘一致
    expect(await store.get(session.id)).not.toHaveProperty("sandboxMode");
  });
});

// ---- session-pagination 组（合并） ----
async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

async function seedMessages(store: SessionStore, sessionId: string, count: number): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    const msg = await store.appendMessage(sessionId, "user", [{ type: "text", text: `message-${i}` }]);
    messages.push(msg);
  }
  return messages;
}

describe("session pagination (0.5.0 Phase 2)", () => {
  it("getTail returns only the last N messages with pagination metadata", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const all = await seedMessages(store, session.id, 250);

    const tail = await store.getTail(session.id, 100);
    expect(tail).toBeDefined();
    expect(tail!.messages).toHaveLength(100);
    expect(tail!.messages[0]!.id).toBe(all[150]!.id);
    expect(tail!.messages[99]!.id).toBe(all[249]!.id);
    expect(tail!.hasMoreMessages).toBe(true);
    expect(tail!.messageCount).toBe(250);
  });

  it("cached tail index extends correctly after append-only growth", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 250);
    const before = await store.getTail(session.id, 100);
    expect(before?.messageCount).toBe(250);

    const appended = await store.appendMessage(session.id, "user", [{ type: "text", text: "after-index" }]);
    const after = await store.getTail(session.id, 100);
    expect(after?.messageCount).toBe(251);
    expect(after?.messages.at(-1)?.id).toBe(appended.id);
    expect(after?.messages[0]?.id).toBe(before?.messages[1]?.id);
  });

  it("getTail returns all messages when fewer than limit", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 30);

    const tail = await store.getTail(session.id, 100);
    expect(tail!.messages).toHaveLength(30);
    expect(tail!.hasMoreMessages).toBe(false);
    expect(tail!.messageCount).toBe(30);
  });

  it("getTail returns empty for new session", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });

    const tail = await store.getTail(session.id, 100);
    expect(tail!.messages).toHaveLength(0);
    expect(tail!.hasMoreMessages).toBe(false);
    expect(tail!.messageCount).toBe(0);
  });

  it("getMessagesBefore returns older messages before a given message ID", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const all = await seedMessages(store, session.id, 250);

    // Request 50 messages before message index 200 (all[200])
    const page = await store.getMessagesBefore(session.id, all[200]!.id, 50);
    expect(page).toBeDefined();
    expect(page!.messages).toHaveLength(50);
    // Should be messages at indices 150..199
    expect(page!.messages[0]!.id).toBe(all[150]!.id);
    expect(page!.messages[49]!.id).toBe(all[199]!.id);
    expect(page!.hasMore).toBe(true);
    expect(page!.totalLines).toBe(250);
  });

  it("getMessagesBefore returns fewer messages near the beginning", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const all = await seedMessages(store, session.id, 250);

    // Request 50 messages before message index 10 (all[10])
    const page = await store.getMessagesBefore(session.id, all[10]!.id, 50);
    expect(page!.messages).toHaveLength(10);
    expect(page!.messages[0]!.id).toBe(all[0]!.id);
    expect(page!.messages[9]!.id).toBe(all[9]!.id);
    expect(page!.hasMore).toBe(false);
  });

  it("getMessagesBefore returns empty when beforeId not found", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 10);

    const page = await store.getMessagesBefore(session.id, "nonexistent-id", 50);
    expect(page!.messages).toHaveLength(0);
    expect(page!.hasMore).toBe(false);
  });

  it("getMessagesBefore returns undefined for nonexistent session", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    // Use a valid UUID format that doesn't exist
    const page = await store.getMessagesBefore("00000000-0000-4000-8000-000000000000", "some-msg-id", 50);
    expect(page).toBeUndefined();
  });

  it("list() surfaces recovery state (tail corruption, missing history, healthy)", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "valid" }]);
    // 健康会话：list() 不解析全部消息，仅做尾部轻量检查
    const healthy = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, healthy.id, 100);

    // Corrupt the tail
    const storeRoot = (store as unknown as { root: string }).root;
    const { writeFile, rm: rmFile } = await import("node:fs/promises");
    await writeFile(
      path.join(storeRoot, session.id, "messages.jsonl"),
      `${JSON.stringify({ id: "valid", role: "user", content: [], createdAt: "x" })}\n{corrupt`,
      "utf8",
    );

    const list = await store.list();
    const found = list.find((item) => item.id === session.id);
    expect(found?.recovery).toMatchObject({ state: "recovered" });
    const healthyFound = list.find((item) => item.id === healthy.id);
    expect(healthyFound).toBeDefined();
    expect(healthyFound!.recovery).toBeUndefined();

    // messages.jsonl 整体缺失：list() 标记 needs_repair
    await rmFile(path.join(storeRoot, session.id, "messages.jsonl"));
    expect((await store.list()).find((item) => item.id === session.id)?.recovery).toMatchObject({ state: "needs_repair" });
  });

  it("full pagination flow: tail → load more → load more → no more", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const all = await seedMessages(store, session.id, 250);

    // Initial load: last 100
    const tail = await store.getTail(session.id, 100);
    expect(tail!.messages).toHaveLength(100);
    expect(tail!.hasMoreMessages).toBe(true);

    // Load more: 100 before the oldest loaded message
    const oldestLoaded = tail!.messages[0]!.id;
    const page1 = await store.getMessagesBefore(session.id, oldestLoaded, 100);
    expect(page1!.messages).toHaveLength(100);
    expect(page1!.hasMore).toBe(true);
    expect(page1!.messages[0]!.id).toBe(all[50]!.id);

    // Load more again
    const oldest2 = page1!.messages[0]!.id;
    const page2 = await store.getMessagesBefore(session.id, oldest2, 100);
    expect(page2!.messages).toHaveLength(50);
    expect(page2!.hasMore).toBe(false);
    expect(page2!.messages[0]!.id).toBe(all[0]!.id);

    // Total loaded: 100 + 100 + 50 = 250 = all messages
    const totalLoaded = tail!.messages.length + page1!.messages.length + page2!.messages.length;
    expect(totalLoaded).toBe(250);
  });
});
