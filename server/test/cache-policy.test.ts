import { describe, expect, it } from "vitest";
import { appendFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SESSION_CACHE_IDLE_MINUTES,
  isCacheEntryIdle,
  resetSessionCacheIdleMinutes,
  sessionCacheIdleTtlMs,
  setSessionCacheIdleMinutes,
} from "../src/cache-policy.js";
import { readAllMessages, readMessagesHead, readMessagesTail, sweepIdleMessageIndexes } from "../src/sessions/message-reader.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("常驻缓存空闲策略", () => {
  it("默认 10 分钟；0 = 不逐出；超出上限按上限收敛", () => {
    resetSessionCacheIdleMinutes();
    expect(sessionCacheIdleTtlMs()).toBe(DEFAULT_SESSION_CACHE_IDLE_MINUTES * 60_000);
    setSessionCacheIdleMinutes(0);
    expect(sessionCacheIdleTtlMs()).toBe(0);
    // 不逐出：多久都不过期
    expect(isCacheEntryIdle(0, Number.MAX_SAFE_INTEGER)).toBe(false);
    setSessionCacheIdleMinutes(5);
    expect(sessionCacheIdleTtlMs()).toBe(5 * 60_000);
    expect(isCacheEntryIdle(1_000, 1_000 + 5 * 60_000 - 1)).toBe(false);
    expect(isCacheEntryIdle(1_000, 1_000 + 5 * 60_000)).toBe(true);
    setSessionCacheIdleMinutes(99_999);
    expect(sessionCacheIdleTtlMs()).toBe(1440 * 60_000);
    resetSessionCacheIdleMinutes();
  });
});

describe("readAllMessages：分块扫描整表读取（不驻留行数组）", () => {
  it("多行 / 空行 / 超长行（跨块）都能解析，恢复状态与分页路径一致", async () => {
    const root = await tempRoot("owc-reader-all-");
    const filePath = path.join(root, "messages.jsonl");
    const long = "x".repeat(200 * 1024);
    const lines = [
      JSON.stringify({ id: "a", role: "user", content: [{ type: "text", text: "hi" }] }),
      "",
      JSON.stringify({ id: "b", role: "assistant", content: [{ type: "text", text: long }] }),
      JSON.stringify({ id: "c", role: "user", content: [{ type: "text", text: "bye" }] }),
    ];
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    const all = await readAllMessages<{ id: string }>(filePath);
    expect(all.messages.map((message) => message.id)).toEqual(["a", "b", "c"]);
    expect(all.recovery).toBeUndefined();
    // 尾部损坏：recovered（与 readMessagesTail 同一口径）
    await appendFile(filePath, "{\"id\":\"broken\"\n", "utf8");
    const withTail = await readAllMessages<{ id: string }>(filePath);
    expect(withTail.messages.map((message) => message.id)).toEqual(["a", "b", "c"]);
    expect(withTail.recovery?.state).toBe("recovered");
    const page = await readMessagesTail<{ id: string }>(filePath, 10);
    expect(page.recovery?.state).toBe("recovered");
    // 中间损坏：needs_repair（把坏行插到中间）
    const middle = `${JSON.stringify({ id: "a", role: "user", content: [] })}\n{broken\n${JSON.stringify({ id: "b", role: "user", content: [] })}\n`;
    await writeFile(filePath, middle, "utf8");
    const withMiddle = await readAllMessages<{ id: string }>(filePath);
    expect(withMiddle.messages).toHaveLength(2);
    expect(withMiddle.recovery?.state).toBe("needs_repair");
    // 文件缺失：needs_repair（不抛错）
    const missing = await readAllMessages(path.join(root, "nope.jsonl"));
    expect(missing.messages).toEqual([]);
    expect(missing.recovery?.state).toBe("needs_repair");
  });

  it("空闲清扫释放消息文件字节索引", async () => {
    const root = await tempRoot("owc-reader-idle-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, `${JSON.stringify({ id: "a", role: "user", content: [] })}\n`, "utf8");
    await readMessagesTail(filePath, 10); // 建索引
    setSessionCacheIdleMinutes(1);
    expect(sweepIdleMessageIndexes(Date.now())).toBe(0);
    expect(sweepIdleMessageIndexes(Date.now() + 60_001)).toBeGreaterThanOrEqual(1);
    // 逐出后重建索引仍能读到同一条
    const page = await readMessagesTail<{ id: string }>(filePath, 10);
    expect(page.messages.map((message) => message.id)).toEqual(["a"]);
    resetSessionCacheIdleMinutes();
  });
});

describe("会话整表缓存：堆字节口径 + 空闲逐出", () => {
  async function storeWithSession(root: string): Promise<{ store: SessionStore; id: string }> {
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const meta = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "hello" }]);
    return { store, id: meta.id };
  }

  it("空闲超时逐出整表缓存（0 = 不逐出）", async () => {
    const root = await tempRoot("owc-store-idle-");
    const { store, id } = await storeWithSession(root);
    await store.get(id); // 填充缓存
    setSessionCacheIdleMinutes(10);
    expect(store.sweepIdleCaches(Date.now())).toBe(0);
    expect(store.sweepIdleCaches(Date.now() + 10 * 60_000 + 1)).toBe(1);
    expect(store.sweepIdleCaches(Date.now() + 60 * 60_000)).toBe(0);
    // 逐出后读取仍然正确（回退到磁盘重建）
    expect(((await store.get(id))?.messages ?? []).length).toBe(1);
    // 0 = 不逐出：再久也不释放
    setSessionCacheIdleMinutes(0);
    await store.get(id);
    expect(store.sweepIdleCaches(Date.now() + 365 * 24 * 60 * 60_000)).toBe(0);
    resetSessionCacheIdleMinutes();
  });

  it("超过单会话堆预算的大会话不驻留（按文件字节 ×3 计权）", async () => {
    const root = await tempRoot("owc-store-big-");
    const { store, id } = await storeWithSession(root);
    // 17MB 单条消息 → 权重 ≈51MB > 48MB 上限：不缓存（宁可下次重读）
    const huge = "y".repeat(17 * 1024 * 1024);
    await store.appendMessage(id, "user", [{ type: "text", text: huge }]);
    const filePath = path.join(root, "sessions", id, "messages.jsonl");
    expect((await stat(filePath)).size).toBeGreaterThan(16 * 1024 * 1024);
    const first = await store.get(id);
    expect(first?.messages).toHaveLength(2);
    // 未驻留：任何超时点都不会逐出条目（本来就没进缓存）
    expect(store.sweepIdleCaches(Date.now() + 365 * 24 * 60 * 60_000)).toBe(0);
    // 也不影响后续读取
    expect((await store.get(id))?.messages).toHaveLength(2);
  });
});

describe("readMessagesHead：头部有界读取（派生标题用）", () => {
  it("只解析前 limit 条非空记录即可得到答案（大历史不整表解析）", async () => {
    const root = await tempRoot("owc-reader-head-");
    const filePath = path.join(root, "messages.jsonl");
    const rows: string[] = [JSON.stringify({ id: "sys", role: "system", content: [] })];
    for (let i = 0; i < 120; i += 1) rows.push(JSON.stringify({ id: `m${i}`, role: "user", content: [{ type: "text", text: `title-${i}` }] }));
    await writeFile(filePath, `${rows.join("\n")}\n`, "utf8");
    const head = await readMessagesHead<{ id: string }>(filePath, 3);
    expect(head.map((row) => row.id)).toEqual(["sys", "m0", "m1"]);
    // limit 覆盖不到时（前若干条都是非用户文本）退回整表读由 store 负责，这里只保证上界
    expect((await readMessagesHead<{ id: string }>(filePath, 500)).length).toBe(121);
    // 空行 / 超长行不干扰计数
    const long = "z".repeat(200 * 1024);
    await writeFile(filePath, `\n${JSON.stringify({ id: "a", role: "user", content: [{ type: "text", text: long }] })}\n\n${JSON.stringify({ id: "b", role: "user", content: [] })}\n`, "utf8");
    expect((await readMessagesHead<{ id: string }>(filePath, 2)).map((row) => row.id)).toEqual(["a", "b"]);
  });
});
