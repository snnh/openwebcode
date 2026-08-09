import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatAssistantStore } from "../src/chat/chat-assistant-store.js";

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
