/**
 * dsh 线格式回归（M-later）：用 vendor 客户端自己的校验代码/描述符断言翻译层输出——
 * `assertSessionWireEvent` / `surfaceOpOf` / follow 首帧的 `assistantStream` 硬要求都从 vendor 产物
 * 原样求值（见 test/helpers/dsh-vendor-wire.ts），参数形状直接读 vendor 生成的 typert 描述符。
 */
import { describe, expect, it, vi } from "vitest";
import { deriveSessionRecords, sessionRecordsCount } from "../src/dsh/web-protocol/session-events.js";
import { projectSessionControlBaseline, projectSessionFollowSnapshot, projectSessionPage } from "../src/dsh/web-protocol/session-projection.js";
import { DshMuxSession, type DshMuxChannel, type DshMuxOutboundFrame } from "../src/dsh/web-protocol/mux.js";
import { buildStreamHandlers, DshEventBridge, type DshWireDeps } from "../src/dsh/web-protocol/streams.js";
import { EventBus } from "../src/events/event-bus.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { assertOpenPayloadShape, vendorDescriptors, vendorWireAssertions, VENDOR_READY } from "./helpers/dsh-vendor-wire.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const message = (id: string, role: ChatMessage["role"], content: ChatMessage["content"], createdAt = "2026-01-01T00:00:00.000Z"): ChatMessage => ({ id, role, content, createdAt });
/** 典型历史：提问 → 助手（思考 + 工具调用）→ 工具结果 → 助手收尾 → 带图提问。 */
const history = (): ChatMessage[] => [
  message("m1", "user", [{ type: "text", text: "看下目录" }], "2026-01-01T00:00:00.000Z"),
  message("m2", "assistant", [{ type: "thinking", text: "先列目录" }, { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "ls" } }], "2026-01-01T00:00:01.000Z"),
  message("m3", "tool", [{ type: "tool_result", toolCallId: "call-1", content: "a.txt", isError: false }], "2026-01-01T00:00:02.000Z"),
  message("m4", "assistant", [{ type: "text", text: "只有 a.txt" }], "2026-01-01T00:00:03.000Z"),
  message("m5", "user", [{ type: "text", text: "谢谢" }, { type: "image", mediaType: "image/png", data: PNG }], "2026-01-01T00:00:04.000Z"),
];

function projectionDeps(messages: ChatMessage[] = history()): DshWireDeps["projection"] {
  const meta = { id: "s1", cwd: "/work/proj", provider: "p", model: "m", title: "会话一", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" };
  return {
    sessions: {
      list: async () => [meta],
      getMeta: async (id: string) => (id === "s1" ? meta : undefined),
      get: async (id: string) => (id === "s1" ? { ...meta, messages } : undefined),
      getTail: async (id: string) => (id === "s1" ? { ...meta, messages, hasMoreMessages: false } : undefined), create: async () => meta,
    },
    agent: {
      run: async () => {}, isRunning: () => false, abort: () => true, enqueueSteering: async () => ({ id: "x", position: 1, reused: false }),
      enqueueFollowUp: async () => ({ id: "y", position: 1, reused: false }), listQueue: async () => [], updateQueue: async () => undefined, removeQueue: async () => false,
    },
    defaultCwd: "/work/default",
  } as never;
}
const sessionRequest = (maxMessages: number, throughSeq?: number, assistantStream?: boolean) =>
  ({ request: { address: { kind: "session" as const, sessionId: "s1" }, maxMessages, ...(throughSeq === undefined ? {} : { throughSeq }), ...(assistantStream === true ? { assistantStream: true } : {}) } });

describe.skipIf(!VENDOR_READY)("dsh 线格式（vendor 真实校验）", () => {
  it("D1：投影事件与 follow/page 的 records 元素逐条通过 vendor assertSessionWireEvent，surface-eligible 必须带 surfaceOp", async () => {
    const assertions = vendorWireAssertions();
    expect(assertions).toBeDefined();
    const { records } = deriveSessionRecords(history());
    expect(records.length).toBeGreaterThan(0);
    const surfaceTypes = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);
    for (const record of records) {
      expect(() => assertions?.assertSessionWireEvent(record.event), JSON.stringify(record.event)).not.toThrow();
      const expected = surfaceTypes.has(record.event.type) ? "append" : undefined;
      expect(record.event.surfaceOp, record.event.type).toBe(expected);
      expect(assertions?.surfaceOpOf(record.event as never), record.event.type).toBe(expected);
    }
    // 反向守卫：漏掉 surfaceOp 时 vendor 校验确实会炸（证明这条断言不是自欺）
    const userEvent = records.find((record) => record.event.type === "user/message")?.event as { surfaceOp?: unknown };
    expect(userEvent).toBeDefined();
    const { surfaceOp: _dropped, ...withoutMarker } = userEvent;
    expect(() => assertions?.assertSessionWireEvent(withoutMarker)).toThrow(/surface-eligible and requires a surfaceOp/);

    const follow = await projectSessionFollowSnapshot({ ...projectionDeps() } as never, sessionRequest(50));
    const snapshot = ("value" in follow ? follow.value : {}) as { records: Array<{ event: unknown }> };
    const page = await projectSessionPage({ ...projectionDeps() } as never, sessionRequest(2, 99));
    const pageValue = ("value" in page ? page.value : {}) as { records: Array<{ event: unknown }> };
    expect(pageValue.records.length).toBeGreaterThan(0);
    for (const record of [...snapshot.records, ...pageValue.records]) expect(() => assertions?.assertSessionWireEvent(record.event)).not.toThrow();
  });

  it("D2：follow 首帧带 assistantStream 基线，通过 vendor 首帧校验与 strict codec", async () => {
    const assertions = vendorWireAssertions();
    const projected = await projectSessionFollowSnapshot({ ...projectionDeps() } as never, sessionRequest(50, undefined, true));
    const value = ("value" in projected ? projected.value : undefined) as Record<string, unknown>;
    expect(value.assistantStream).toEqual({ revision: 0 });
    expect(() => assertions?.assertFollowSnapshot(value)).not.toThrow();
    const descriptor = (await vendorDescriptors()).get("session/follow");
    expect(descriptor, "vendor 缺少 session/follow 描述符").toBeDefined();
    expect(descriptor?.result.create().parse(value)).toBeDefined();
    // 反向守卫：省掉基线正是客户端拒绝的形态
    expect(() => assertions?.assertFollowSnapshot({ ...value, assistantStream: undefined })).toThrow(/assistant stream omitted/);
  });

  it("D3：session/control 描述符无参数，真实端点接受客户端 payload 并产出基线（strict codec 通过）", async () => {
    const descriptor = (await vendorDescriptors()).get("session/control");
    expect(descriptor, "vendor 缺少 session/control 描述符").toBeDefined();
    expect(descriptor?.parameters).toEqual([]);
    assertOpenPayloadShape(descriptor!, { args: {} }); // 客户端编码形态：无参数端点也是 {args:{}}
    expect(() => assertOpenPayloadShape(descriptor!, { args: { sessionId: "s1" } })).toThrow(/未声明参数 sessionId/);

    // 真实端点（buildStreamHandlers 解析，不用假 handler）：payload 与客户端一致 → item 基线帧
    const deps = {
      projection: projectionDeps(), events: new EventBus(), home: "/home/tester",
      respondPermission: vi.fn(async () => {}), respondInteraction: vi.fn(async () => {}), logger: { warn: () => {} },
    } as unknown as DshWireDeps;
    const streams = buildStreamHandlers(deps, new DshEventBridge(deps));
    const frames: DshMuxOutboundFrame[] = [];
    const session = new DshMuxSession({ send: (frame) => frames.push(frame), close: () => {} } as DshMuxChannel, (endpoint) => streams.get(endpoint));
    session.handleText(JSON.stringify({ type: "open", streamId: "ctl", endpoint: "session/control", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames[0]?.type).toBe("item");
    const value = (frames[0] as { value: unknown }).value;
    expect(descriptor?.result.create().parse(value)).toBeDefined();
    expect(value).toMatchObject({ type: "baseline", value: { jobs: {} } });
  });

  it("D9：asOfSeq 与记录 seq 同口径（列表/控制基线 = 末条记录 seq = 快照 cursor）", async () => {
    const messages = history();
    const full = deriveSessionRecords(messages);
    expect([sessionRecordsCount(messages), sessionRecordsCount([]), sessionRecordsCount([message("a1", "assistant", [{ type: "text", text: "x" }])])])
      .toEqual([full.records.length, 0, 3]); // 计数推导与事件投影严格等价（省掉逐条物化）
    const deps = projectionDeps(messages);
    const control = await projectSessionControlBaseline(deps as never);
    const entry = (("value" in control ? control.value : {}) as { value: { projections: Record<string, { asOfSeq: number }> } }).value.projections.s1;
    expect(entry?.asOfSeq).toBe(full.records.length - 1);
    const follow = await projectSessionFollowSnapshot(deps as never, sessionRequest(50));
    const snapshot = ("value" in follow ? follow.value : {}) as { cursor: number; projections: { asOfSeq: number } };
    expect([snapshot.projections.asOfSeq, snapshot.cursor]).toEqual([snapshot.cursor, full.records.length - 1]);
  });
});
