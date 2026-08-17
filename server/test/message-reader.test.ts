/**
 * message-reader 索引构建（scanRange）的专项测试，覆盖 1.8.x 优化点的等价性：
 * - 空白/纯空白行（空格/tab/CR/NBSP/BOM/U+2028/U+3000）不进索引 —— isBlankLine
 *   与 `text.trim() === ""` 等价的观察面；非法 UTF-8 行与行首空白+内容行不判空；
 * - 超长单行（>64KB chunk 边界，构造 300KB base64 风格内容）与常规行混合文件：
 *   lines 偏移/长度经消息全文往返断言，byId 经 readMessagesBefore 断言；
 *   endsWithNewline 由增量测试（尾换行走扩展、无尾换行走重建）间接锁定；
 * - id 提取：行首 1KB 内常规行、content 在前 id 越过 1KB 的 legacy 布局
 *   （整行回退路径）、无 36-hex id 的行；
 * - 增量扫描：先扫再追加（跨 chunk 行），确认拼接处行为正确。
 * 全部经 readMessagesTail/readMessagesBefore 公共导出面断言人工构造的预期值。
 */
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readMessagesBefore, readMessagesTail } from "../src/sessions/message-reader.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

const uuid = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const textMsg = (id: string, text: string): string =>
  JSON.stringify({ id, role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z" });
const textOf = (message: ChatMessage): string => {
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
};
/** 字节精确拼装 jsonl：空白行/多字节字符/非法字节需要原始 Buffer 控制。 */
const jsonl = (...parts: Array<string | Buffer>): Buffer =>
  Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8"))));

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 300KB base64 风格内容：单行远超 64KB 读取 chunk，跨多个 chunk 边界。 */
const BIG_TEXT = B64_ALPHABET.repeat(Math.ceil((300 * 1024) / B64_ALPHABET.length)).slice(0, 300 * 1024);

describe("空白/纯空白行不进索引（isBlankLine 与 trim 等价的观察面）", () => {
  const blankVariants: Array<[string, Buffer]> = [
    ["空行", Buffer.alloc(0)],
    ["空格", Buffer.from("   ")],
    ["tab", Buffer.from("\t\t")],
    ["混合 ASCII 空白", Buffer.from(" \t ")],
    ["CR（CRLF 行拆分产物）", Buffer.from("\r")],
    ["NBSP", Buffer.from([0xc2, 0xa0])],
    ["BOM/ZWNBSP", Buffer.from([0xef, 0xbb, 0xbf])],
    ["U+2028 行分隔符", Buffer.from([0xe2, 0x80, 0xa8])],
    ["U+3000 全角空格", Buffer.from([0xe3, 0x80, 0x80])],
  ];
  it.each(blankVariants)("两条消息之间的%s被跳过，不产生索引行与恢复标记", async (_name, blank) => {
    const root = await tempRoot("owc-reader-blank-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), "first"), "\n", blank, "\n", textMsg(uuid(1), "second"), "\n"));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.recovery).toBeUndefined();
    expect(page.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    expect(page.messages.map(textOf)).toEqual(["first", "second"]);
  });

  it("纯空白文件无记录", async () => {
    const root = await tempRoot("owc-reader-blank-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl("\n\n  \n"));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page).toEqual({ messages: [], hasMore: false, totalLines: 0 });
  });

  it("非法 UTF-8 字节行不判空：按 U+FFFD 解码为内容行，损坏触发 needs_repair", async () => {
    const root = await tempRoot("owc-reader-blank-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), "first"), "\n", Buffer.from([0xff, 0xff]), "\n", textMsg(uuid(1), "second"), "\n"));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(3);
    expect(page.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    expect(page.recovery).toMatchObject({ state: "needs_repair" });
  });

  it("行首空白+内容不是空行：JSON.parse 接受前导空白，正常记录", async () => {
    const root = await tempRoot("owc-reader-blank-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl("  ", textMsg(uuid(0), "padded"), "\n", textMsg(uuid(1), "plain"), "\n"));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(2);
    expect(page.recovery).toBeUndefined();
    expect(page.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    expect(textOf(page.messages[0]!)).toBe("padded");
  });

  it("CRLF 行尾：\\r 作为行内容一部分，JSON.parse 接受 → 正常记录且 byId 可查", async () => {
    const root = await tempRoot("owc-reader-blank-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), "a"), "\r\n", textMsg(uuid(1), "b"), "\r\n"));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(2);
    expect(page.recovery).toBeUndefined();
    expect(page.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    const before = await readMessagesBefore<ChatMessage>(filePath, uuid(1), 10);
    expect(before.messages.map((m) => m.id)).toEqual([uuid(0)]);
  });
});

describe("超长单行（>64KB chunk）与常规行混合扫描", () => {
  it("300KB 行 + 常规行：尾读全量/尾读 1 条/向前翻页一致", async () => {
    const root = await tempRoot("owc-reader-huge-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), BIG_TEXT), "\n", textMsg(uuid(1), "small-1"), "\n", textMsg(uuid(2), "small-2"), "\n"));

    const tail = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(tail.totalLines).toBe(3);
    expect(tail.hasMore).toBe(false);
    expect(tail.recovery).toBeUndefined();
    expect(tail.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1), uuid(2)]);
    expect(textOf(tail.messages[0]!)).toBe(BIG_TEXT);

    const lastOne = await readMessagesTail<ChatMessage>(filePath, 1);
    expect(lastOne.messages.map((m) => m.id)).toEqual([uuid(2)]);
    expect(lastOne.hasMore).toBe(true);

    const beforeTail = await readMessagesBefore<ChatMessage>(filePath, uuid(2), 10);
    expect(beforeTail.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    expect(beforeTail.hasMore).toBe(false);
    expect(beforeTail.totalLines).toBe(3);

    const beforeMid = await readMessagesBefore<ChatMessage>(filePath, uuid(1), 10);
    expect(beforeMid.messages.map((m) => m.id)).toEqual([uuid(0)]);

    const beforeHead = await readMessagesBefore<ChatMessage>(filePath, uuid(0), 10);
    expect(beforeHead.messages).toEqual([]);
    expect(beforeHead.hasMore).toBe(false);
  });

  it("超大行作末行且无尾换行：全文往返，结束判定正确", async () => {
    const root = await tempRoot("owc-reader-huge-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(1), "small"), "\n", textMsg(uuid(0), BIG_TEXT)));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.messages.map((m) => m.id)).toEqual([uuid(1), uuid(0)]);
    expect(textOf(page.messages[1]!)).toBe(BIG_TEXT);
  });

  it("仅一条超大行无尾换行", async () => {
    const root = await tempRoot("owc-reader-huge-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), BIG_TEXT)));

    const page = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(page.totalLines).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.messages.map((m) => m.id)).toEqual([uuid(0)]);
    expect(textOf(page.messages[0]!)).toBe(BIG_TEXT);
  });
});

describe("id 提取（行首 1KB 切片 + 整行回退）", () => {
  it("legacy 布局：content 在前、id 越过 1KB → 整行回退路径仍建 byId", async () => {
    const root = await tempRoot("owc-reader-id-");
    const filePath = path.join(root, "messages.jsonl");
    const legacy = JSON.stringify({ content: [{ type: "text", text: "J".repeat(2500) }], id: uuid(5), role: "user", createdAt: "x" });
    await writeFile(filePath, jsonl(legacy, "\n", textMsg(uuid(6), "after"), "\n"));

    const before = await readMessagesBefore<ChatMessage>(filePath, uuid(6), 10);
    expect(before.messages).toHaveLength(1);
    expect(before.messages[0]!.id).toBe(uuid(5));
    expect(textOf(before.messages[0]!)).toBe("J".repeat(2500));
  });

  it("id 非首键但整行 ≤1KB：整行正则分支命中", async () => {
    const root = await tempRoot("owc-reader-id-");
    const filePath = path.join(root, "messages.jsonl");
    const reordered = JSON.stringify({ role: "user", id: uuid(7), content: [{ type: "text", text: "reordered" }], createdAt: "x" });
    await writeFile(filePath, jsonl(reordered, "\n", textMsg(uuid(8), "after"), "\n"));

    const before = await readMessagesBefore<ChatMessage>(filePath, uuid(8), 10);
    expect(before.messages).toHaveLength(1);
    expect(before.messages[0]!.id).toBe(uuid(7));
  });

  it("无 36-hex id 的行不建 byId，但行仍计入 totalLines", async () => {
    const root = await tempRoot("owc-reader-id-");
    const filePath = path.join(root, "messages.jsonl");
    const noId = JSON.stringify({ role: "user", content: [{ type: "text", text: "no id" }], createdAt: "x" });
    const compaction = JSON.stringify({ id: "compaction:2026-08-17T02:40:37.455Z", role: "user", content: [], createdAt: "x" });
    await writeFile(filePath, jsonl(noId, "\n", compaction, "\n", textMsg(uuid(9), "real"), "\n"));

    const miss = await readMessagesBefore<ChatMessage>(filePath, "compaction:2026-08-17T02:40:37.455Z", 10);
    expect(miss.messages).toEqual([]);
    expect(miss.hasMore).toBe(false);
    expect(miss.totalLines).toBe(3);

    const before = await readMessagesBefore<ChatMessage>(filePath, uuid(9), 10);
    expect(before.messages).toHaveLength(2);
    expect(before.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(textOf(before.messages[0]!)).toBe("no id");
    expect(textOf(before.messages[1]!)).toBe("");
  });
});

describe("增量扫描（追加后索引扩展/重建）", () => {
  it("尾换行文件追加跨 chunk 超大行：扩展路径拼接正确", async () => {
    const root = await tempRoot("owc-reader-incr-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), "a"), "\n", textMsg(uuid(1), "b"), "\n"));
    const first = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(first.totalLines).toBe(2);

    await appendFile(filePath, jsonl(textMsg(uuid(2), BIG_TEXT), "\n", textMsg(uuid(3), "d"), "\n"));
    const second = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(second.totalLines).toBe(4);
    expect(second.hasMore).toBe(false);
    expect(second.recovery).toBeUndefined();
    expect(second.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1), uuid(2), uuid(3)]);
    expect(textOf(second.messages[2]!)).toBe(BIG_TEXT);

    const before = await readMessagesBefore<ChatMessage>(filePath, uuid(2), 10);
    expect(before.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
  });

  it("无尾换行文件追加：索引全量重建仍正确", async () => {
    const root = await tempRoot("owc-reader-incr-");
    const filePath = path.join(root, "messages.jsonl");
    await writeFile(filePath, jsonl(textMsg(uuid(0), "a")));
    const first = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(first.totalLines).toBe(1);

    await appendFile(filePath, jsonl("\n", textMsg(uuid(1), BIG_TEXT), "\n"));
    const second = await readMessagesTail<ChatMessage>(filePath, 10);
    expect(second.totalLines).toBe(2);
    expect(second.messages.map((m) => m.id)).toEqual([uuid(0), uuid(1)]);
    expect(textOf(second.messages[1]!)).toBe(BIG_TEXT);
  });
});
