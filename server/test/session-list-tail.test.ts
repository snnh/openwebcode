import { appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

// list() 的恢复检测改为只读文件尾部窗口（checkRecoveryTail，不建全量字节索引）。
// 这里钉住尾部窗口的边界语义：末条记录比窗口长时指数扩大、无终止换行、
// 末尾空白行跳过——list() 结果必须与逐行全扫一致。

async function storeAt(root: string): Promise<SessionStore> {
  const store = new SessionStore(path.join(root, "sessions"));
  await store.initialize();
  return store;
}

function messagesPathOf(root: string, sessionId: string): string {
  return path.join(root, "sessions", sessionId, "messages.jsonl");
}

describe("session list() tail-only recovery check", () => {
  it("healthy last record larger than the tail window: no recovery flag", async () => {
    const root = await tempRoot("owc-listtail-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "small" }]);
    // 末条约 1MiB（远超 256KiB 首窗），触发窗口指数扩大；合法 JSON 不得误报 recovered
    await store.appendMessage(session.id, "assistant", [{ type: "text", text: "x".repeat(1024 * 1024) }]);

    const found = (await store.list()).find((item) => item.id === session.id);
    expect(found).toBeDefined();
    expect(found!.recovery).toBeUndefined();
  });

  it("corrupt last record larger than the tail window: recovered", async () => {
    const root = await tempRoot("owc-listtail-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "small" }]);
    await appendFile(messagesPathOf(root, session.id), `{corrupt-${"x".repeat(1024 * 1024)}`, "utf8");

    const found = (await store.list()).find((item) => item.id === session.id);
    expect(found!.recovery).toMatchObject({ state: "recovered" });
  });

  it("last record without trailing newline: healthy parse, no recovery flag", async () => {
    const root = await tempRoot("owc-listtail-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "first" }]);
    const last = JSON.stringify({ id: "00000000-0000-4000-8000-0000000000cc", role: "user", content: [], createdAt: "x" });
    await appendFile(messagesPathOf(root, session.id), last, "utf8"); // 无终止换行

    const found = (await store.list()).find((item) => item.id === session.id);
    expect(found!.recovery).toBeUndefined();
  });

  it("trailing blank lines after a valid record: no recovery flag", async () => {
    const root = await tempRoot("owc-listtail-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await store.appendMessage(session.id, "user", [{ type: "text", text: "first" }]);
    await appendFile(messagesPathOf(root, session.id), "\n\n  \n", "utf8");

    const found = (await store.list()).find((item) => item.id === session.id);
    expect(found!.recovery).toBeUndefined();
  });

  it("whitespace-only file: no records, no recovery flag", async () => {
    const root = await tempRoot("owc-listtail-");
    const store = await storeAt(root);
    const session = await store.create({ cwd: os.tmpdir(), provider: "p", model: "m" });
    await writeFile(messagesPathOf(root, session.id), "\n\n \n", "utf8");

    const found = (await store.list()).find((item) => item.id === session.id);
    expect(found!.recovery).toBeUndefined();
  });
});
