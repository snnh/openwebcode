/** dsh 会话事件序列投影单测（M4 步骤 14c）；有 vendor 时用客户端生成 codec 校验 follow/page 形状。 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveSessionRecords, pageWindow, sessionLastSeq, sessionRecordsCount, snapshotWindow } from "../src/dsh/web-protocol/session-events.js";
import { projectSessionFollowSnapshot, projectSessionPage } from "../src/dsh/web-protocol/session-projection.js";
import type { ChatMessage } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGIN = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins", "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");
const VENDOR_SKIP = existsSync(VENDOR_PLUGIN) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）"; // 缺失时跳过 codec 复核
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const message = (id: string, role: ChatMessage["role"], content: ChatMessage["content"], createdAt = "2026-01-01T00:00:00.000Z"): ChatMessage => ({ id, role, content, createdAt });
/** 一段典型历史：用户提问 → 助手（思考 + 工具调用）→ 工具结果 → 助手收尾 → 带图提问。 */
const history = (): ChatMessage[] => [
  message("m1", "user", [{ type: "text", text: "看下目录" }], "2026-01-01T00:00:00.000Z"),
  message("m2", "assistant", [{ type: "thinking", text: "先列目录" }, { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "ls" } }], "2026-01-01T00:00:01.000Z"),
  message("m3", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "a.txt", isError: false }], "2026-01-01T00:00:02.000Z"),
  message("m4", "assistant", [{ type: "text", text: "目录里只有 a.txt" }], "2026-01-01T00:00:03.000Z"),
  message("m5", "user", [{ type: "text", text: "谢谢" }, { type: "image", mediaType: "image/png", data: PNG }], "2026-01-01T00:00:04.000Z"),
];

function fakeDeps(messages: ChatMessage[] = history()) {
  const meta = { id: "s1", cwd: "/work/proj", provider: "p", model: "m", title: "会话一", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" };
  return {
    sessions: {
      list: async () => [meta],
      getMeta: async (id: string) => (id === "s1" ? meta : undefined),
      get: async (id: string) => (id === "s1" ? { ...meta, messages } : undefined),
      getTail: async (id: string) => (id === "s1" ? { ...meta, messages, hasMoreMessages: false } : undefined), create: async () => meta,
    },
    agent: { run: async () => {}, isRunning: () => false, abort: () => true, enqueueSteering: async () => ({ id: "x", position: 1, reused: false }), enqueueFollowUp: async () => ({ id: "y", position: 1, reused: false }), listQueue: async () => [], updateQueue: async () => undefined, removeQueue: async () => false },
    defaultCwd: "/work/default",
  } as never;
}
const sessionRequest = (maxMessages: number, throughSeq?: number) => ({ request: { address: { kind: "session" as const, sessionId: "s1" }, maxMessages, ...(throughSeq === undefined ? {} : { throughSeq }) } });
describe("dsh 会话事件序列投影", () => {
  it("turn/step 包围、事件类型与 seq 连续、turn 序号随用户消息、派生结果稳定", () => {
    const { records } = deriveSessionRecords(history());
    expect(records.map((record) => record.event.type)).toEqual([
      "turn/start", "step/start", "user/message", "tool/call", "assistant/message", "tool/result", "assistant/message", "step/end", "turn/end", "turn/start", "step/start", "user/message", "step/end", "turn/end",
    ]);
    // seq 从 0 起连续（vendor 的 emptyCursor = -1、follows(l, r) = r === l + 1 都以此为前提）
    expect(records.map((record) => record.event.seq)).toEqual([...Array(records.length).keys()]);
    const userEvents = records.filter((record) => record.event.type === "user/message");
    expect(userEvents.map((record) => (record.event.data as { id: string }).id)).toEqual(["m1", "m5"]);
    expect(records.find((record) => record.event.type === "assistant/message")?.event.data).toMatchObject({ turn: 1, step: 1, stream: [] });
    expect(deriveSessionRecords(history()).records).toEqual(records); // 同一份输入派生结果稳定
  });
  it("内容块映射：thinking→reasoning、tool_call→tool-call、图片带真实尺寸、视频降级为文本", () => {
    const { records } = deriveSessionRecords([
      message("m1", "user", [{ type: "text", text: "hi" }]),
      message("m2", "assistant", [{ type: "thinking", text: "想一下" }, { type: "tool_call", id: "call-9", name: "read_file", input: { path: "a" } }, { type: "video", mediaType: "video/mp4", data: "AAAA" }]),
      message("m3", "user", [{ type: "image", mediaType: "image/png", data: PNG }]),
    ]);
    const assistantBlock = records.find((record) => record.event.type === "assistant/message")?.event.data as { message: { content: Array<Record<string, unknown>> } };
    expect(assistantBlock.message.content).toMatchObject([
      { type: "reasoning", text: "想一下" },
      { type: "tool-call", id: "call-9", name: "read_file", arguments: JSON.stringify({ path: "a" }) }, { type: "text" },
    ]);
    expect(assistantBlock.message.content[2]?.text as string).toContain("视频附件"); // 视频降级为文本
    expect(records.find((record) => record.event.type === "tool/call")?.event.data).toMatchObject({ turn: 1, step: 1, callId: "call-9", name: "read_file" });
    const userImage = records.filter((record) => record.event.type === "user/message").at(-1)?.event.data as { content: Array<Record<string, unknown>> };
    expect(userImage.content[0]).toMatchObject({ type: "image", attachment: { attachmentId: "m3#0", mediaType: "image/png", width: 1, height: 1, bytes: 70 } });
  });
  it("窗口：快照只取末尾消息、分页边界、运行中末轮不收尾（记录 seq 稳定）", () => {
    const messages = history();
    const full = deriveSessionRecords(messages);
    const cursor = full.records.at(-1)?.event.seq ?? 0;
    const snapshot = snapshotWindow(messages, 2);
    expect(snapshot.hasMore).toBe(true);
    expect([snapshot.cursor, snapshot.totalRecords]).toEqual([cursor, full.records.length]);
    // 窗口从 m4 起：m4 的 assistant 收尾 + turn1 关闭 + m5 的整个 turn
    expect(snapshot.records.map((record) => record.event.type)).toEqual([
      "assistant/message", "step/end", "turn/end", "turn/start", "step/start", "user/message", "step/end", "turn/end",
    ]);
    expect(snapshotWindow(messages, 50).hasMore).toBe(false);
    // 断流修复路径（replaceThrough）：页尾必须**恰好**是请求的 throughSeq（vendor assertPageThrough）
    const firstPage = pageWindow(messages, cursor, undefined, 2);
    expect(firstPage.records.at(-1)?.event.seq).toBe(cursor);
    // loadOlder 路径（prepend）：tail + 1 === beforeSeq
    const older = pageWindow(messages, cursor, firstPage.records[0]?.event.seq, 2);
    expect(older.records.at(-1)?.event.seq).toBe((firstPage.records[0]?.event.seq ?? 0) - 1);
    expect(pageWindow(messages, -1, undefined, 2).records).toEqual([]); // 空会话（throughSeq = -1）
    // 增量稳定性：运行中的末轮不收尾，已有记录 seq 不因新消息落盘而变动（否则客户端吞掉回复）
    const prompts = [message("u1", "user", [{ type: "text", text: "一" }], "2026-01-01T00:00:00.000Z")];
    const reply = message("a1", "assistant", [{ type: "text", text: "答" }], "2026-01-01T00:00:01.000Z");
    const mid = deriveSessionRecords(prompts, undefined, false).records; // 运行中：末轮无 step/end + turn/end
    expect(mid.map((record) => record.event.type)).toEqual(["turn/start", "step/start", "user/message"]);
    const withReply = deriveSessionRecords([...prompts, reply], undefined, false).records; // 回复落盘：尾部追加
    expect(withReply.slice(0, mid.length).map((record) => [record.event.seq, record.event.type]))
      .toEqual(mid.map((record) => [record.event.seq, record.event.type]));
    expect(withReply.at(-1)).toMatchObject({ event: { seq: mid.length, type: "assistant/message" } });
    const closed = deriveSessionRecords([...prompts, reply], undefined, true).records; // 回合结束：仍尾部追加
    expect(closed.slice(withReply.length).map((record) => record.event.type)).toEqual(["step/end", "turn/end"]);
    // 计数口径与之一致（水位 = 末条记录 seq）
    expect([sessionRecordsCount(prompts, false), sessionLastSeq(prompts, false), sessionRecordsCount(prompts, true)]).toEqual([mid.length, mid.length - 1, mid.length + 2]);
  });
});

describe("dsh follow/page 投影", () => {
  it("follow 快照齐备、异常地址如实报错；page 返回 records/hasMore、缺 address 报参数错误", async () => {
    const projected = await projectSessionFollowSnapshot(fakeDeps(), sessionRequest(50));
    expect(projected).toMatchObject({ value: { type: "snapshot", header: { version: 1, id: "s1", isSeeded: false, cwd: "/work/proj" }, hasMore: false } });
    const value = "value" in projected ? projected.value as { records: unknown[]; cursor: number; projections: { asOfSeq: number } } : undefined;
    expect(Array.isArray(value?.records)).toBe(true);
    expect(value?.projections.asOfSeq).toBe(value?.cursor);
    expect(value?.cursor).toBeGreaterThan(0);
    expect(await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "subagent", parentSessionId: "s1", childSessionId: "s2", mode: "one-shot" } } }))
      .toMatchObject({ error: { code: "gateway/bad-request" } });
    expect(await projectSessionFollowSnapshot(fakeDeps(), { request: { address: { kind: "session", sessionId: "nope" } } }))
      .toMatchObject({ error: { code: "session/not-found" } });
    const cursor = deriveSessionRecords(history()).records.at(-1)?.event.seq ?? 0;
    const page = await projectSessionPage(fakeDeps(), sessionRequest(2, cursor));
    expect(page).toMatchObject({ value: { hasMore: true } });
    expect(await projectSessionPage(fakeDeps(), { request: {} })).toMatchObject({ error: { code: "gateway/bad-request" } });
    // vendor 就绪时再用客户端生成的 strict codec 复核两者形状
    if (VENDOR_SKIP === undefined) {
      const remote = (await import(`file://${VENDOR_PLUGIN}`)) as { default: { descriptors: Array<{ namespace: string; method: string; result: { create: () => { parse: (value: unknown) => unknown } } }> } };
      const codec = (endpoint: string) => {
        const descriptor = remote.default.descriptors.find((entry) => `${entry.namespace}/${entry.method}` === endpoint);
        expect(descriptor, `vendor 缺少 ${endpoint}`).toBeDefined();
        return descriptor!.result.create();
      };
      expect(codec("session/follow").parse("value" in projected ? projected.value : undefined)).toBeDefined();
      expect(codec("session/page").parse("value" in page ? page.value : undefined)).toBeDefined();
    }
  });
});
