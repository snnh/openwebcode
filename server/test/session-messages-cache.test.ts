import { appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

// readMessages 整表缓存的等价性测试：缓存路径的 get() 必须与全新实例
// （空缓存、纯磁盘读取）的 get() 深度一致，覆盖追加穿透、外部写入失效、
// steering 插入、truncate、recovery 与 parentId 派生等全部语义。

async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

/** 同一 root 上的全新实例：空缓存，get() 走整盘读取，作为等价性基准。 */
async function freshRead(root: string, sessionId: string) {
  const fresh = await storeAt(root);
  return fresh.get(sessionId);
}

function messagesPathOf(root: string, sessionId: string): string {
  return path.join(root, "sessions", sessionId, "messages.jsonl");
}

async function seedMessages(store: SessionStore, sessionId: string, count: number): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(await store.appendMessage(sessionId, "user", [{ type: "text", text: `message-${i}` }]));
  }
  return messages;
}

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
