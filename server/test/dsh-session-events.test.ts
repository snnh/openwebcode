/**
 * dsh 会话事件序列投影单测（M4 步骤 14c）。
 * 有 vendor 时用客户端生成 codec 校验 follow 快照与 page 结果的形状。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveSessionRecords, pageWindow, snapshotWindow } from "../src/dsh/web-protocol/session-events.js";
import { projectSessionFollowSnapshot, projectSessionPage } from "../src/dsh/web-protocol/session-projection.js";
import type { ChatMessage } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGIN = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins", "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");
const VENDOR_SKIP = existsSync(VENDOR_PLUGIN) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

function message(id: string, role: ChatMessage["role"], content: ChatMessage["content"], createdAt = "2026-01-01T00:00:00.000Z"): ChatMessage {
  return { id, role, content, createdAt };
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 一段典型历史：用户提问 → 助手（文本 + 工具调用）→ 工具结果 → 助手收尾。 */
function history(): ChatMessage[] {
  return [
    message("m1", "user", [{ type: "text", text: "看下目录" }], "2026-01-01T00:00:00.000Z"),
    message("m2", "assistant", [
      { type: "thinking", text: "先列目录" },
      { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "ls" } },
    ], "2026-01-01T00:00:01.000Z"),
    message("m3", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "a.txt", isError: false }], "2026-01-01T00:00:02.000Z"),
    message("m4", "assistant", [{ type: "text", text: "目录里只有 a.txt" }], "2026-01-01T00:00:03.000Z"),
    message("m5", "user", [{ type: "text", text: "谢谢" }, { type: "image", mediaType: "image/png", data: PNG }], "2026-01-01T00:00:04.000Z"),
  ];
}

function fakeDeps(messages: ChatMessage[] = history()) {
  const meta = { id: "s1", cwd: "/work/proj", provider: "p", model: "m", title: "会话一", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" };
  return {
    sessions: {
      list: async () => [meta],
      getMeta: async (id: string) => (id === "s1" ? meta : undefined),
      get: async (id: string) => (id === "s1" ? { ...meta, messages } : undefined),
      getTail: async (id: string) => (id === "s1" ? { ...meta, messages, hasMoreMessages: false } : undefined),
      create: async () => meta,
    },
    agent: { run: async () => {}, isRunning: () => false, abort: () => true, enqueueSteering: async () => ({ id: "x", position: 1, reused: false }), enqueueFollowUp: async () => ({ id: "y", position: 1, reused: false }), listQueue: async () => [], updateQueue: async () => undefined, removeQueue: async () => false },
    defaultCwd: "/work/default",
  } as never;
}

describe("dsh 会话事件序列投影", () => {
  it("turn/step 包围、user/assistant/tool 事件类型与 seq 连续", () => {
    const { records } = deriveSessionRecords(history());
    expect(records.map((record) => record.event.type)).toEqual([
      "turn/start", "step/start", "user/message",
      "tool/call", "assistant/message",
      "tool/result",
      "assistant/message",
      "step/end", "turn/end",
      "turn/start", "step/start", "user/message",
      "step/end", "turn/end",
    ]);
    expect(records.map((record) => record.event.seq)).toEqual([...Array(records.length).keys()].map((index) => index + 1));
    // turn 序号 = 用户消息序号；step 恒为 1（owc 无 step 概念）
    const userEvents = records.filter((record) => record.event.type === "user/message");
    expect(userEvents.map((record) => (record.event.data as { id: string }).id)).toEqual(["m1", "m5"]);
    const assistant = records.find((record) => record.event.type === "assistant/message");
    expect(assistant?.event.data).toMatchObject({ turn: 1, step: 1, stream: [] });
    // 同一份输入派生结果稳定（快照与分页 cursor 一致的前提）
    expect(deriveSessionRecords(history()).records).toEqual(records);
  });

  it("内容块映射：thinking→reasoning、tool_call→tool-call、图片带真实尺寸、视频降级为文本", () => {
    const { records } = deriveSessionRecords([
      message("m1", "user", [{ type: "text", text: "hi" }]),
      message("m2", "assistant", [
        { type: "thinking", text: "想一下" },
        { type: "tool_call", id: "call-9", name: "read_file", input: { path: "a" } },
        { type: "video", mediaType: "video/mp4", data: "AAAA" },
      ]),
      message("m3", "user", [{ type: "image", mediaType: "image/png", data: PNG }]),
    ]);
    const assistant = records.find((record) => record.event.type === "assistant/message");
    const blocks = (assistant?.event.data as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(blocks[0]).toEqual({ type: "reasoning", text: "想一下" });
    expect(blocks[1]).toMatchObject({ type: "tool-call", id: "call-9", name: "read_file" });
    expect(blocks[1]?.arguments).toBe(JSON.stringify({ path: "a" }));
    expect(blocks[2]).toMatchObject({ type: "text" });
    expect((blocks[2]?.text as string)).toContain("视频附件");
    const call = records.find((record) => record.event.type === "tool/call");
    expect(call?.event.data).toMatchObject({ turn: 1, step: 1, callId: "call-9", name: "read_file" });
    const userImage = records.filter((record) => record.event.type === "user/message").at(-1);
    const imageBlock = (userImage?.event.data as { content: Array<Record<string, unknown>> }).content[0];
    expect(imageBlock).toMatchObject({ type: "image", attachment: { attachmentId: "m3#0", mediaType: "image/png", width: 1, height: 1, bytes: 70 } });
  });

  it("快照窗口：maxMessages 只取末尾消息，hasMore 与 cursor 与全量一致", () => {
    const messages = history();
    const full = deriveSessionRecords(messages);
    const window = snapshotWindow(messages, 2);
    expect(window.hasMore).toBe(true);
    expect(window.cursor).toBe(full.records.at(-1)?.event.seq);
    expect(window.totalRecords).toBe(full.records.length);
    // 窗口从 m4 起：m4 的 assistant 收尾 + turn1 关闭 + m5 的整个 turn
    expect(window.records.map((record) => record.event.type)).toEqual([
      "assistant/message", "step/end", "turn/end",
      "turn/start", "step/start", "user/message", "step/end", "turn/end",
    ]);
    expect(snapshotWindow(messages, 50).hasMore).toBe(false);
  });

  it("分页：throughSeq 之前取一页，消息边界对齐且 hasMore 正确", () => {
    const messages = history();
    const full = deriveSessionRecords(messages);
    const cursor = full.records.at(-1)?.event.seq ?? 0;
    const firstPage = pageWindow(messages, cursor, undefined, 2);
    expect(firstPage.records.length).toBeGreaterThan(0);
    // 第一页不含最后一页的首条记录（按 seq 严格向前）
    const nextPage = pageWindow(messages, cursor, firstPage.records[0]?.event.seq, 2);
    expect(nextPage.records.every((record) => record.event.seq < (firstPage.records[0]?.event.seq ?? 0))).toBe(true);
    expect(pageWindow(messages, 1, undefined, 2).records).toEqual([]);
  });
});

describe("dsh follow/page 投影", () => {
  it("follow 快照：header/cursor/records/hasMore/projections 齐备；子代理地址如实报不支持", async () => {
    const projected = await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 50 } });
    expect(projected).toMatchObject({
      value: {
        type: "snapshot",
        header: { version: 1, id: "s1", isSeeded: false, cwd: "/work/proj" },
        hasMore: false,
      },
    });
    const value = "value" in projected ? projected.value as { records: unknown[]; cursor: number; projections: { asOfSeq: number } } : undefined;
    expect(Array.isArray(value?.records)).toBe(true);
    expect(value?.cursor).toBeGreaterThan(0);
    expect(value?.projections.asOfSeq).toBe(value?.cursor);
    expect(await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "subagent", parentSessionId: "s1", childSessionId: "s2", mode: "one-shot" } } }))
      .toMatchObject({ error: { code: "session/unsupported" } });
    expect(await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "session", sessionId: "nope" } } }))
      .toMatchObject({ error: { code: "session/not-found" } });
  });

  it("page：返回 records/hasMore；缺 address 报参数错误", async () => {
    const full = deriveSessionRecords(history());
    const cursor = full.records.at(-1)?.event.seq ?? 0;
    const projected = await projectSessionPage(fakeDeps(), { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: cursor, maxMessages: 2 } });
    expect(projected).toMatchObject({ value: { hasMore: true } });
    expect(await projectSessionPage(fakeDeps(), { request: {} })).toMatchObject({ error: { code: "session/unsupported" } });
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("dsh follow/page 形状（客户端 codec 校验）", () => {
  it("快照与分页结果通过生成的 strict schema", async () => {
    const remote = (await import(`file://${VENDOR_PLUGIN}`)) as { default: { descriptors: Array<{ namespace: string; method: string; result: { create: () => { parse: (value: unknown) => unknown } } }> } };
    const codec = (endpoint: string): { create: () => { parse: (value: unknown) => unknown } } => {
      const descriptor = remote.default.descriptors.find((entry) => `${entry.namespace}/${entry.method}` === endpoint);
      expect(descriptor, `vendor 缺少 ${endpoint}`).toBeDefined();
      return descriptor!.result;
    };
    const follow = await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 50 } });
    expect(codec("session/follow").create().parse("value" in follow ? follow.value : undefined)).toBeDefined();
    const full = deriveSessionRecords(history());
    const page = await projectSessionPage(fakeDeps(), { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: full.records.at(-1)?.event.seq ?? 0, maxMessages: 2 } });
    expect(codec("session/page").create().parse("value" in page ? page.value : undefined)).toBeDefined();
  });
});
