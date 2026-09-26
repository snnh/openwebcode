import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import { activePathMessages } from "../src/sessions/session-tree.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

async function newSession(store: SessionStore, cwd = os.tmpdir()): Promise<string> {
  return (await store.create({ cwd, provider: "p", model: "m" })).id;
}

async function seedMessages(store: SessionStore, sessionId: string, count: number): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) messages.push(await store.appendMessage(sessionId, "user", [{ type: "text", text: `message-${i}` }]));
  return messages;
}

function messagesPathOf(root: string, sessionId: string): string {
  return path.join(root, "sessions", sessionId, "messages.jsonl");
}

/** 全新实例且空缓存地读一遍：缓存路径的 get() 必须与它深度一致 */
async function freshRead(root: string, sessionId: string) {
  return (await storeAt(root)).get(sessionId);
}

describe("SessionStore.appendMessage 并发串行化", () => {
  it("并发追加大消息不交织坏行；单条失败不阻断后续追加", async () => {
    const root = await tempRoot("owc-session-store-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: root, provider: "p", model: "m" });
    // 1MB 级消息底层多次 write，未串行化时最易交织成坏行
    const big = "x".repeat(1024 * 1024);
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.appendMessage(session.id, "user", [{ type: "text", text: `${index}:${big}` }])));
    const lines = (await readFile(messagesPathOf(root, session.id), "utf8")).split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(8);
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { content: Array<{ text: string }> };
      const match = /^(\d):x+$/.exec(parsed.content[0]!.text); expect(match, "每行必须是完整 JSON 且内容未被其他消息交织").toBeTruthy();
      seen.add(match![1]!);
    }
    expect(seen.size).toBe(8);
    // 对不存在的会话追加失败（readMeta 抛错）后，同一 store 的后续追加仍能落盘
    const other = await newSession(store, root);
    await expect(store.appendMessage("missing-session", "user", [{ type: "text", text: "x" }])).rejects.toThrow();
    await store.appendMessage(other, "user", [{ type: "text", text: "正常消息" }]);
    expect((await store.get(other))!.messages).toHaveLength(1);
  });
});

describe("SessionStore.updateSandboxMode", () => {
  it("sandboxMode undefined 保留现值；显式值落盘；空 setupScript 删除", async () => {
    const root = await tempRoot("owc-sandbox-mode-");
    const store = await storeAt(root);
    const id = await newSession(store, root);
    const preserved = await store.updateSandboxMode(id, "bubblewrap", undefined);
    expect(preserved.sandboxMode).toBe("bubblewrap");
    // sandboxMode 缺省：保留现值；setupScript 照常写入
    expect(await store.updateSandboxMode(id, undefined, "echo hi")).toMatchObject({ sandboxMode: "bubblewrap", setupScript: "echo hi" });
    // setupScript 缺省/空 → 从元数据删除
    const off = await store.updateSandboxMode(id, "off", undefined); expect(off).toMatchObject({ sandboxMode: "off" });
    expect(off).not.toHaveProperty("setupScript");
    // 显式 jobobject/appcontainer 同样真值落盘
    expect((await store.updateSandboxMode(id, "jobobject", undefined)).sandboxMode).toBe("jobobject");
    await store.updateSandboxMode(id, "appcontainer", undefined); expect((await store.get(id))?.sandboxMode).toBe("appcontainer");
  });

  it("create 显式落盘平台默认档；Windows 存量缺字段 meta 迁移为 jobobject", async () => {
    const root = await tempRoot("owc-sandbox-migrate-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: root, provider: "p", model: "m" });
    expect(session.sandboxMode).toBe(process.platform === "win32" ? "appcontainer" : "bubblewrap");
    // 1.10.0 前的存量 meta：手工写入缺 sandboxMode 的 meta.json
    const legacyId = "00000000-0000-4000-8000-000000000001";
    const legacy = path.join(root, "sessions", legacyId);
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "meta.json"), JSON.stringify({
      id: legacyId, cwd: root, provider: "p", model: "m", title: "legacy",
      createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    }), "utf8");
    await writeFile(path.join(legacy, "messages.jsonl"), "", "utf8");
    const loaded = await store.get(legacyId);
    if (process.platform === "win32") {
      // Windows 存量保持创建时的 Job Object 档位（一次性补写），不被静默改判 AppContainer
      expect(loaded?.sandboxMode).toBe("jobobject");
      expect(JSON.parse(await readFile(path.join(legacy, "meta.json"), "utf8"))).toMatchObject({ sandboxMode: "jobobject" });
    } else {
      // POSIX 存量不迁移：缺省即当前默认后端
      expect(loaded?.sandboxMode).toBeUndefined();
    }
  });
});

describe("会话分页", () => {
  it("getTail 边界（超限截尾/不足全量/空会话）与追加后的增量索引", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const big = await newSession(store);
    const all = await seedMessages(store, big, 250);
    const tail = await store.getTail(big, 100); expect(tail!.messages).toHaveLength(100);
    expect(tail!.messages[0]!.id).toBe(all[150]!.id); expect(tail!.messages[99]!.id).toBe(all[249]!.id);
    expect(tail!.hasMoreMessages).toBe(true); expect(tail!.messageCount).toBe(250);
    const small = await newSession(store);
    await seedMessages(store, small, 30);
    const few = await store.getTail(small, 100); expect(few!.messages).toHaveLength(30);
    expect(few).toMatchObject({ hasMoreMessages: false, messageCount: 30 });
    expect(await store.getTail(await newSession(store), 100)).toMatchObject({ messages: [], hasMoreMessages: false, messageCount: 0 });
    // 追加穿透已建立的尾部索引
    const appended = await store.appendMessage(big, "user", [{ type: "text", text: "after-index" }]);
    const after = await store.getTail(big, 100); expect(after?.messageCount).toBe(251);
    expect(after?.messages.at(-1)?.id).toBe(appended.id); expect(after?.messages[0]?.id).toBe(tail!.messages[1]!.id);
  });

  it("getMessagesBefore 分页边界与 tail→load more 链", async () => {
    const store = await storeAt(await tempRoot("owc-page-"));
    const session = await newSession(store);
    const all = await seedMessages(store, session, 250);
    const page = await store.getMessagesBefore(session, all[200]!.id, 50);
    expect(page!.messages.map((message) => message.id)).toEqual(all.slice(150, 200).map((message) => message.id));
    expect(page).toMatchObject({ hasMore: true, totalLines: 250 });
    const nearStart = await store.getMessagesBefore(session, all[10]!.id, 50);
    expect(nearStart!.messages.map((message) => message.id)).toEqual(all.slice(0, 10).map((message) => message.id));
    expect(nearStart!.hasMore).toBe(false);
    expect(await store.getMessagesBefore(session, "nonexistent-id", 50)).toMatchObject({ messages: [], hasMore: false });
    expect(await store.getMessagesBefore("00000000-0000-4000-8000-000000000000", "some-msg-id", 50)).toBeUndefined();
    // 连续翻页：100 + 100 + 50 覆盖全部消息
    const tail = await store.getTail(session, 100);
    const page1 = await store.getMessagesBefore(session, tail!.messages[0]!.id, 100);
    const page2 = await store.getMessagesBefore(session, page1!.messages[0]!.id, 100);
    expect(page1!.messages[0]!.id).toBe(all[50]!.id); expect(page1!.hasMore).toBe(true); expect(page2!.messages).toHaveLength(50);
    expect(page2!.messages[0]!.id).toBe(all[0]!.id); expect(page2!.hasMore).toBe(false);
    expect(tail!.messages.length + page1!.messages.length + page2!.messages.length).toBe(250);
  });

  it("list() 上报恢复状态：尾行损坏 / 整体缺失 / 健康", async () => {
    const root = await tempRoot("owc-page-");
    const store = await storeAt(root);
    const healthy = await newSession(store);
    await seedMessages(store, healthy, 100);
    const session = await newSession(store);
    await writeFile(messagesPathOf(root, session), `${JSON.stringify({ id: "valid", role: "user", content: [], createdAt: "x" })}\n{corrupt`, "utf8");
    const list = await store.list();
    expect(list.find((item) => item.id === session)?.recovery).toMatchObject({ state: "recovered" });
    // 健康会话 list() 不解析全部消息，不带 recovery
    expect(list.find((item) => item.id === healthy)).not.toHaveProperty("recovery");
    const { rm } = await import("node:fs/promises");
    await rm(messagesPathOf(root, session));
    expect((await store.list()).find((item) => item.id === session)?.recovery).toMatchObject({ state: "needs_repair" });
  });
});
describe("readMessages 整表缓存的等价性", () => {
  it("append-through（含 parentId 链）与绕过 SessionStore 的外部写入后，缓存读取等于全新实例", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await newSession(store);
    await seedMessages(store, session, 10);
    await store.get(session); // 建立缓存
    const assistant = await store.appendMessage(session, "assistant", [
      { type: "text", text: "reply" },
      { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.ts" } },
    ]);
    await store.appendMessage(session, "tool", [{ type: "tool_result", toolCallId: "call_1", content: "ok", isError: false }]);
    const cached = await store.get(session); expect(cached).toEqual(await freshRead(root, session));
    expect(cached!.messages).toHaveLength(12); expect(cached!.messages.at(-2)!.id).toBe(assistant.id);
    expect(cached!.messages.at(-2)!.parentId).toBe(cached!.messages.at(-3)!.id);
    expect(cached!.messages.at(-1)!.parentId).toBe(assistant.id);
    // 外部追加使缓存失效，且外部消息无 parentId 时派生链接到前一条
    const externalSession = await newSession(store);
    await seedMessages(store, externalSession, 5);
    await store.get(externalSession);
    await appendFile(messagesPathOf(root, externalSession), `${JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000aa", role: "user", content: [{ type: "text", text: "external" }], createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    const afterExternal = await store.get(externalSession); expect(afterExternal).toEqual(await freshRead(root, externalSession));
    expect(afterExternal!.messages).toHaveLength(6);
    expect(afterExternal!.messages.at(-1)!.parentId).toBe(afterExternal!.messages.at(-2)!.id);
  });

  it("steering 显式 lineage 与旧线性日志的 parentId 派生在缓存路径下保持一致", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    // steering/follow-up 插入走 appendMessage + 显式 lineage
    const session = await newSession(store);
    const seeded = await seedMessages(store, session, 5);
    await store.get(session);
    const steered = await store.appendMessage(session, "user", [{ type: "text", text: "steer" }], {
      parentId: seeded[2]!.id, runId: "run-1", turnId: "turn-1",
    });
    const cached = await store.get(session); expect(cached).toEqual(await freshRead(root, session));
    expect(cached!.messages.at(-1)).toMatchObject({ id: steered.id, parentId: seeded[2]!.id, runId: "run-1", turnId: "turn-1" });
    // 无 parentId 的旧线性日志：读取时派生父链，且缓存命中后保持稳定
    const legacy = await newSession(store);
    await writeFile(messagesPathOf(root, legacy), ["a", "b", "c"].map((text, i) => JSON.stringify({
      id: `00000000-0000-4000-8000-00000000000${i}`, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z",
    })).join("\n") + "\n", "utf8");
    const first = await store.get(legacy);
    const second = await store.get(legacy); expect(first).toEqual(await freshRead(root, legacy)); expect(second).toEqual(first);
    expect(second!.messages[0]!.parentId).toBeUndefined(); expect(second!.messages[1]!.parentId).toBe(second!.messages[0]!.id);
    expect(second!.messages[2]!.parentId).toBe(second!.messages[1]!.id);
  });
  // B1 回归：截断（检查点回退）后不重置 activeLeafId 会留下悬空父链，
  // 后续 appendMessage 的 parentId 指向已删消息，模型上下文只剩新消息。
  it("truncateMessages 使缓存与分页索引失效，且回退后接续追加保持活动路径完整", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await newSession(store);
    const early = await seedMessages(store, session, 3);
    expect((await store.getTail(session, 2))!.messages.map((message) => message.id)).toEqual([early[1]!.id, early[2]!.id]);
    await store.appendMessage(session, "assistant", [{ type: "text", text: "later-1" }]);
    const later = await store.appendMessage(session, "user", [{ type: "text", text: "later-2" }]);
    await store.truncateMessages(session, 3); // 与 POST /checkpoints/:id/restore 的消息侧动作一致
    // 分页索引按新文件重建：已截掉的消息不再可定位
    expect((await store.getMessagesBefore(session, later.id, 10))!.messages).toEqual([]);
    const afterRestore = await store.appendMessage(session, "user", [{ type: "text", text: "after-restore" }]);
    const detail = await store.get(session); expect(detail!.messages).toHaveLength(4);
    expect(detail!.activeLeafId).toBe(afterRestore.id); expect(afterRestore.parentId).toBe(early[2]!.id);
    expect(activePathMessages(detail!.messages, detail!.activeLeafId).map((message) => message.id))
      .toEqual([early[0]!.id, early[1]!.id, early[2]!.id, afterRestore.id]);
    expect(detail).toEqual(await freshRead(root, session));
    expect((await store.getTail(session, 10))!.messages.map((message) => message.id))
      .toEqual([early[0]!.id, early[1]!.id, early[2]!.id, afterRestore.id]);
  });

  it("损坏尾行 / 中间行 / 整体缺失：recovery 状态与缓存读取一致", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const tailCorrupt = await newSession(store);
    await seedMessages(store, tailCorrupt, 5);
    await appendFile(messagesPathOf(root, tailCorrupt), "{corrupt-tail", "utf8");
    const cached = await store.get(tailCorrupt); expect(cached).toEqual(await freshRead(root, tailCorrupt));
    expect(cached).toMatchObject({ recovery: { state: "recovered" } }); expect(cached!.messages).toHaveLength(5);
    expect(await store.get(tailCorrupt)).toEqual(cached);
    const middleCorrupt = await newSession(store);
    await seedMessages(store, middleCorrupt, 5);
    await store.get(middleCorrupt);
    const lines = (await readFile(messagesPathOf(root, middleCorrupt), "utf8")).split("\n");
    lines[2] = "{corrupt-middle";
    await writeFile(messagesPathOf(root, middleCorrupt), lines.join("\n"), "utf8");
    const middle = await store.get(middleCorrupt); expect(middle).toEqual(await freshRead(root, middleCorrupt));
    expect(middle).toMatchObject({ recovery: { state: "needs_repair" } }); expect(middle!.messages).toHaveLength(4);
    const { rm } = await import("node:fs/promises");
    const missing = await newSession(store);
    await rm(messagesPathOf(root, missing));
    expect(await store.get(missing)).toMatchObject({ recovery: { state: "needs_repair", message: "messages.jsonl is missing" }, messages: [] });
    await appendFile(messagesPathOf(root, missing), `${JSON.stringify({ id: "00000000-0000-4000-8000-0000000000bb", role: "user", content: [], createdAt: "x" })}\n`, "utf8");
    const restored = await store.get(missing); expect(restored).toEqual(await freshRead(root, missing));
    expect(restored!.messages).toHaveLength(1); expect(restored!.recovery).toBeUndefined();
  });

  it("追加前修复损坏的尾部记录，而不是把坏行埋进中间", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const session = await newSession(store);
    await seedMessages(store, session, 5);
    await appendFile(messagesPathOf(root, session), "{corrupt-tail\n", "utf8");
    await store.get(session); // 缓存 recovery=recovered（已知尾行损坏）
    await store.appendMessage(session, "user", [{ type: "text", text: "after-corrupt" }]);
    const cached = await store.get(session); expect(cached).toEqual(await freshRead(root, session));
    expect(cached!.recovery).toBeUndefined(); expect(cached!.messages).toHaveLength(6);
    expect(await readFile(messagesPathOf(root, session), "utf8")).not.toContain("corrupt-tail");
  });

  it("追加前修复被中断的尾部记录：残缺字节丢弃，缺终止换行只补换行", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    // 崩在行中：末记录是无终止换行的残缺字节
    const broken = await newSession(store);
    await seedMessages(store, broken, 3);
    await appendFile(messagesPathOf(root, broken), '{"id":"partial","role":"user"', "utf8");
    const freshStore = await storeAt(root); // 全新实例：无内存缓存，靠「末字节不是 \n」识别
    await freshStore.appendMessage(broken, "user", [{ type: "text", text: "after-partial" }]);
    expect(await readFile(messagesPathOf(root, broken), "utf8")).not.toContain('"id":"partial"');
    const repaired = await freshStore.get(broken); expect(repaired!.recovery).toBeUndefined();
    expect(repaired!.messages).toHaveLength(4);
    // 末记录完整但缺终止换行（崩在写 \n 之前）：只补换行，不丢记录也不与下一条拼行
    const unterminated = await newSession(store);
    const kept = await seedMessages(store, unterminated, 2);
    await writeFile(messagesPathOf(root, unterminated), JSON.stringify(kept[1]), "utf8");
    const storeB = await storeAt(root);
    await storeB.appendMessage(unterminated, "user", [{ type: "text", text: "third" }]);
    const lines = (await readFile(messagesPathOf(root, unterminated), "utf8")).split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(2); expect((JSON.parse(lines[0]!) as { id: string }).id).toBe(kept[1]!.id);
    const detail = await storeB.get(unterminated); expect(detail!.recovery).toBeUndefined();
    expect(detail!.messages).toHaveLength(2);
  });

  it("并发会话缓存不串味；调用方改动返回的数组不污染缓存", async () => {
    const root = await tempRoot("owc-msgcache-");
    const store = await storeAt(root);
    const a = await newSession(store);
    const b = await newSession(store);
    await seedMessages(store, a, 5);
    await seedMessages(store, b, 7);
    await store.get(a);
    await store.get(b);
    await store.appendMessage(a, "user", [{ type: "text", text: "only-a" }]);
    const cachedA = await store.get(a);
    const cachedB = await store.get(b); expect(cachedA).toEqual(await freshRead(root, a));
    expect(cachedB).toEqual(await freshRead(root, b)); expect(cachedA!.messages).toHaveLength(6);
    expect(cachedB!.messages).toHaveLength(7);
    cachedA!.messages.push({ id: "fake", role: "user", content: [], createdAt: "x" } as ChatMessage);
    cachedA!.messages.splice(0, 2);
    const second = await store.get(a); expect(second!.messages).toHaveLength(6); expect(second).toEqual(await freshRead(root, a));
  });
});
