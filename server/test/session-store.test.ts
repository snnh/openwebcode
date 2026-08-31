import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  it("sandboxMode undefined 保留现值；显式值写入（含 appcontainer 真值）；空 setupScript 删除", async () => {
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
    // 显式 jobobject（不再是默认档）持久化
    const jobobject = await store.updateSandboxMode(session.id, "jobobject", undefined);
    expect(jobobject.sandboxMode).toBe("jobobject");
    // 显式 appcontainer 同样真值落盘：缺省字段只属于 1.10.0 前的存量 meta（readMeta 迁移）
    const cleared = await store.updateSandboxMode(session.id, "appcontainer", undefined);
    expect(cleared.sandboxMode).toBe("appcontainer");
    // 落盘一致
    expect((await store.get(session.id))?.sandboxMode).toBe("appcontainer");
  });

  it("create 显式落盘平台默认档；Windows 存量缺字段 meta 迁移为 jobobject", async () => {
    const root = await tempRoot("owc-sandbox-migrate-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const session = await store.create({ cwd: root, provider: "p", model: "m" });
    // 新会话：sandboxMode 显式落盘（win32=appcontainer，POSIX=bubblewrap）
    expect(session.sandboxMode).toBe(process.platform === "win32" ? "appcontainer" : "bubblewrap");

    // 模拟 1.10.0 前的存量 meta：手工写入缺 sandboxMode 的 meta.json
    const legacyId = "00000000-0000-4000-8000-000000000001";
    const legacy = path.join(root, "sessions", legacyId);
    await mkdir(legacy, { recursive: true });
    const legacyMeta = { id: legacyId, cwd: root, provider: "p", model: "m", title: "legacy", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };
    await writeFile(path.join(legacy, "meta.json"), JSON.stringify(legacyMeta), "utf8");
    await writeFile(path.join(legacy, "messages.jsonl"), "", "utf8");
    const loaded = await store.get(legacyId);
    if (process.platform === "win32") {
      // Windows 存量：保持创建时的 Job Object 档位（一次性补写），不被静默改判 AppContainer
      expect(loaded?.sandboxMode).toBe("jobobject");
      const persisted = JSON.parse(await readFile(path.join(legacy, "meta.json"), "utf8")) as { sandboxMode?: string };
      expect(persisted.sandboxMode).toBe("jobobject");
    } else {
      // POSIX 存量：不迁移，缺省即当前默认后端（bubblewrap）
      expect(loaded?.sandboxMode).toBeUndefined();
    }
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

async function freshRead(root: string, sessionId: string) {
  const fresh = await storeAt(root);
  return fresh.get(sessionId);
}

function messagesPathOf(root: string, sessionId: string): string {
  return path.join(root, "sessions", sessionId, "messages.jsonl");
}

// readMessages 整表缓存的等价性测试：缓存路径的 get() 必须与全新实例
// （空缓存、纯磁盘读取）的 get() 深度一致，覆盖追加穿透、外部写入失效、
// steering 插入、truncate、recovery 与 parentId 派生等全部语义。

describe("session messages cache (readMessages whole-list cache)", () => {
  it("cached get() equals fresh read after seeding", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 20);

    const first = await store.get(session.id); // 冷加载，建立缓存
    const second = await store.get(session.id); // 缓存命中
    const fresh = await freshRead(root, session.id);
    expect(second).toEqual(fresh);
    expect(first).toEqual(fresh);
    expect(second!.messages).toHaveLength(20);
  });

  it("append-through keeps cached get() equal to fresh read (run-style appends)", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 10);
    await store.get(session.id); // 建立缓存

    // 模拟 agent run 的 turn：assistant + tool_result 追加，turn 边界再次 get()
    const assistant = await store.appendMessage(session.id, "assistant", [
      { type: "text", text: "reply" },
      { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.ts" } },
    ]);
    await store.appendMessage(session.id, "tool", [
      { type: "tool_result", toolCallId: "call_1", content: "ok", isError: false },
    ]);
    const cached = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(cached!.messages).toHaveLength(12);
    expect(cached!.messages.at(-2)!.id).toBe(assistant.id);
    // parentId 链保持：assistant 的 parent 是追加前最后一条
    expect(cached!.messages.at(-2)!.parentId).toBe(cached!.messages.at(-3)!.id);
    expect(cached!.messages.at(-1)!.parentId).toBe(assistant.id);
  });

  it("steering-style insert with explicit lineage parentId stays equivalent", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const seeded = await seedMessages(store, session.id, 5);
    await store.get(session.id);

    // steering/follow-up 插入走 appendMessage + 显式 lineage（agent-runner.ts:1705）
    const steered = await store.appendMessage(session.id, "user", [{ type: "text", text: "steer" }], {
      parentId: seeded[2]!.id,
      runId: "run-1",
      turnId: "turn-1",
    });
    const cached = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(cached!.messages.at(-1)).toMatchObject({ id: steered.id, parentId: seeded[2]!.id, runId: "run-1", turnId: "turn-1" });
  });

  it("external append (bypassing SessionStore) invalidates the cache", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await store.get(session.id); // 建立缓存

    const external: ChatMessage = {
      id: "00000000-0000-4000-8000-0000000000aa",
      role: "user",
      content: [{ type: "text", text: "external" }],
      createdAt: new Date().toISOString(),
    };
    await appendFile(messagesPathOf(root, session.id), `${JSON.stringify(external)}\n`, "utf8");

    const after = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(after).toEqual(fresh);
    expect(after!.messages).toHaveLength(6);
    // 外部消息无 parentId：读取派生链接到前一条
    expect(after!.messages.at(-1)!.parentId).toBe(after!.messages.at(-2)!.id);
  });

  it("truncateMessages invalidates the cache", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 10);
    await store.get(session.id);

    await store.truncateMessages(session.id, 4);
    const cached = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(cached!.messages).toHaveLength(4);
  });

  it("derives parentId for old linear logs and keeps it stable across cache hits", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const lines = ["a", "b", "c"].map((text, i) => JSON.stringify({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(messagesPathOf(root, session.id), lines.join("\n") + "\n", "utf8");

    const first = await store.get(session.id);
    const second = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(first).toEqual(fresh);
    expect(second).toEqual(fresh);
    expect(second!.messages[0]!.parentId).toBeUndefined();
    expect(second!.messages[1]!.parentId).toBe(second!.messages[0]!.id);
    expect(second!.messages[2]!.parentId).toBe(second!.messages[1]!.id);
  });

  it("corrupt tail: cached get() reports recovered and equals fresh read", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await appendFile(messagesPathOf(root, session.id), "{corrupt-tail", "utf8");

    const cached = await store.get(session.id);
    const again = await store.get(session.id); // 命中缓存的 recovery 也要一致
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(again).toEqual(fresh);
    expect(cached!.recovery).toMatchObject({ state: "recovered" });
    expect(cached!.messages).toHaveLength(5);
  });

  it("append after a corrupt tail escalates to needs_repair and equals fresh read", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await appendFile(messagesPathOf(root, session.id), "{corrupt-tail\n", "utf8");
    await store.get(session.id); // 缓存 recovery=recovered

    // 追加后损坏行不再处于尾部 → needs_repair；缓存必须失效重建而非增量
    await store.appendMessage(session.id, "user", [{ type: "text", text: "after-corrupt" }]);
    const cached = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(cached!.recovery).toMatchObject({ state: "needs_repair" });
    expect(cached!.messages).toHaveLength(6);
  });

  it("corrupt middle record: needs_repair, equals fresh read", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    await store.get(session.id);

    const filePath = messagesPathOf(root, session.id);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    lines[2] = "{corrupt-middle";
    await writeFile(filePath, lines.join("\n"), "utf8");

    const cached = await store.get(session.id);
    const again = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(cached).toEqual(fresh);
    expect(again).toEqual(fresh);
    expect(cached!.recovery).toMatchObject({ state: "needs_repair" });
    expect(cached!.messages).toHaveLength(4);
  });

  it("missing messages.jsonl: needs_repair, and recovery after external recreate", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(messagesPathOf(root, session.id));

    const missing = await store.get(session.id);
    expect(missing!.recovery).toMatchObject({ state: "needs_repair", message: "messages.jsonl is missing" });
    expect(missing!.messages).toHaveLength(0);

    await appendFile(messagesPathOf(root, session.id), `${JSON.stringify({ id: "00000000-0000-4000-8000-0000000000bb", role: "user", content: [], createdAt: "x" })}\n`, "utf8");
    const restored = await store.get(session.id);
    const fresh = await freshRead(root, session.id);
    expect(restored).toEqual(fresh);
    expect(restored!.recovery).toBeUndefined();
    expect(restored!.messages).toHaveLength(1);
  });

  it("concurrent sessions do not cross-contaminate the cache", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const a = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    const b = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, a.id, 5);
    await seedMessages(store, b.id, 7);
    await store.get(a.id);
    await store.get(b.id);

    await store.appendMessage(a.id, "user", [{ type: "text", text: "only-a" }]);
    const cachedA = await store.get(a.id);
    const cachedB = await store.get(b.id);
    expect(cachedA).toEqual(await freshRead(root, a.id));
    expect(cachedB).toEqual(await freshRead(root, b.id));
    expect(cachedA!.messages).toHaveLength(6);
    expect(cachedB!.messages).toHaveLength(7);
  });

  it("mutating the returned array does not poison the cache", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await seedMessages(store, session.id, 5);
    const first = await store.get(session.id);
    first!.messages.push({ id: "fake", role: "user", content: [], createdAt: "x" } as ChatMessage);
    first!.messages.splice(0, 2);

    const second = await store.get(session.id);
    expect(second!.messages).toHaveLength(5);
    expect(second).toEqual(await freshRead(root, session.id));
  });
});
