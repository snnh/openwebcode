import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-page-"));
  roots.push(root);
  return root;
}

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
    const store = await storeAt(await tempDir());
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
    const store = await storeAt(await tempDir());
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
    const store = await storeAt(await tempDir());
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const all = await seedMessages(store, session.id, 30);

    const tail = await store.getTail(session.id, 100);
    expect(tail!.messages).toHaveLength(30);
    expect(tail!.hasMoreMessages).toBe(false);
    expect(tail!.messageCount).toBe(30);
  });

  it("getTail returns empty for new session", async () => {
    const store = await storeAt(await tempDir());
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });

    const tail = await store.getTail(session.id, 100);
    expect(tail!.messages).toHaveLength(0);
    expect(tail!.hasMoreMessages).toBe(false);
    expect(tail!.messageCount).toBe(0);
  });

  it("getMessagesBefore returns older messages before a given message ID", async () => {
    const store = await storeAt(await tempDir());
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
    const store = await storeAt(await tempDir());
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
    const store = await storeAt(await tempDir());
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 10);

    const page = await store.getMessagesBefore(session.id, "nonexistent-id", 50);
    expect(page!.messages).toHaveLength(0);
    expect(page!.hasMore).toBe(false);
  });

  it("getMessagesBefore returns undefined for nonexistent session", async () => {
    const store = await storeAt(await tempDir());
    // Use a valid UUID format that doesn't exist
    const page = await store.getMessagesBefore("00000000-0000-4000-8000-000000000000", "some-msg-id", 50);
    expect(page).toBeUndefined();
  });

  it("list() does not parse all messages — only checks tail corruption", async () => {
    const store = await storeAt(await tempDir());
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 100);

    const list = await store.list();
    const found = list.find((item) => item.id === session.id);
    expect(found).toBeDefined();
    expect(found!.recovery).toBeUndefined();
  });

  it("list() detects tail corruption via lightweight check", async () => {
    const store = await storeAt(await tempDir());
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "valid" }]);

    // Corrupt the tail
    const storeRoot = (store as unknown as { root: string }).root;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(storeRoot, session.id, "messages.jsonl"),
      `${JSON.stringify({ id: "valid", role: "user", content: [], createdAt: "x" })}\n{corrupt`,
      "utf8",
    );

    const list = await store.list();
    const found = list.find((item) => item.id === session.id);
    expect(found?.recovery).toMatchObject({ state: "recovered" });
  });

  it("full pagination flow: tail → load more → load more → no more", async () => {
    const store = await storeAt(await tempDir());
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
