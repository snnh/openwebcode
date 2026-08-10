import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatAssistantStore } from "../src/chat/chat-assistant-store.js";
import { ChatSessionStore } from "../src/chat/chat-session-store.js";

describe("ChatSessionStore", () => {
  let dir: string;
  let store: ChatSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chat-test-"));
    store = new ChatSessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates and retrieves a session", async () => {
    const meta = await store.create({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.provider).toBe("anthropic");
    expect(meta.title).toBe("New chat");

    const retrieved = await store.get(meta.id);
    expect(retrieved?.id).toBe(meta.id);
  });

  it("lists sessions sorted by updatedAt desc", async () => {
    const s1 = await store.create({ provider: "a", model: "m1" });
    const s2 = await store.create({ provider: "a", model: "m2" });
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(s2.id);
    expect(list[1]!.id).toBe(s1.id);
  });

  it("renames a session", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const renamed = await store.rename(meta.id, "My Chat");
    expect(renamed.title).toBe("My Chat");
  });

  it("deletes a session", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.delete(meta.id);
    expect(await store.get(meta.id)).toBeUndefined();
  });

  it("appends messages and derives title from first user message", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "Hello world this is a test message" }]);

    const updated = await store.get(meta.id);
    expect(updated?.title).toBe("Hello world this is a test message");

    const messages = await store.getMessages(meta.id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("maintains parentId chain for session tree", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msg1 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    const msg2 = await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);
    const msg3 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "Second" }]);

    expect(msg2.parentId).toBe(msg1.id);
    expect(msg3.parentId).toBe(msg2.id);
  });

  it("branches a session (copies active path)", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "Question" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Answer" }]);

    const branch = await store.branch(meta.id);
    expect(branch.id).not.toBe(meta.id);

    const branchMessages = await store.getMessages(branch.id);
    expect(branchMessages.length).toBe(2);
    expect(branchMessages[0]!.content[0]!.type).toBe("text");
  });

  it("checkouts to a specific message", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msg1 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);

    const checked = await store.checkout(meta.id, msg1.id);
    expect(checked.activeLeafId).toBe(msg1.id);
  });

  it("checkout rejects a non-existent messageId", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await expect(store.checkout(meta.id, "does-not-exist")).rejects.toThrow("Message not found");
  });

  it("retries from a user message (backtracks activeLeaf)", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);
    const msg3 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "Second" }]);

    const retried = await store.retry(meta.id, msg3.id);
    expect(retried.activeLeafId).not.toBe(msg3.id);
  });

  it("rejects invalid session IDs", async () => {
    await expect(store.get("../etc/passwd")).rejects.toThrow();
    await expect(store.get("not-a-uuid")).rejects.toThrow();
  });

  it("paginates messages with getMessagesBefore", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await store.appendMessage(meta.id, "user", [{ type: "text", text: `Message ${i}` }]));
    }

    const before = await store.getMessagesBefore(meta.id, msgs[5]!.id, 3);
    expect(before.length).toBeLessThanOrEqual(3);
  });
});

describe("ChatAssistantStore", () => {
  let dir: string;
  let store: ChatAssistantStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "chat-asst-"));
    store = new ChatAssistantStore(path.join(dir, "assistants.json"));
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates default assistants on first init", async () => {
    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.name === "通用助手")).toBe(true);
    expect(list.some((a) => a.name === "编程助手")).toBe(true);
  });

  it("creates a custom assistant", async () => {
    const asst = await store.create({
      name: "Test Assistant",
      systemPrompt: "You are a test bot",
      temperature: 0.5,
    });
    expect(asst.id).toBeDefined();
    expect(asst.name).toBe("Test Assistant");
    expect(asst.temperature).toBe(0.5);
  });

  it("updates an assistant", async () => {
    const asst = await store.create({ name: "Original", systemPrompt: "Original prompt" });
    const updated = await store.update(asst.id, { name: "Updated", temperature: 0.8 });
    expect(updated.name).toBe("Updated");
    expect(updated.temperature).toBe(0.8);
    expect(updated.systemPrompt).toBe("Original prompt");
  });

  it("deletes an assistant", async () => {
    const asst = await store.create({ name: "ToDelete", systemPrompt: "" });
    await store.delete(asst.id);
    expect(await store.get(asst.id)).toBeUndefined();
  });

  it("persists across store instances", async () => {
    await store.create({ name: "Persistent", systemPrompt: "test" });
    const store2 = new ChatAssistantStore(path.join(dir, "assistants.json"));
    await store2.init();
    const list = await store2.list();
    expect(list.some((a) => a.name === "Persistent")).toBe(true);
  });
});
