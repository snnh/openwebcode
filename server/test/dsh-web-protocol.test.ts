/** dsh 翻译层骨架单测：wire 信封、逻辑流复用、$events 连接代、真实端点（非假解析器）。 */
import { describe, expect, it, vi } from "vitest";
import {
  DSH_CLOSE_PROTOCOL, DSH_MAX_STREAMS_PER_CONNECTION, DshMuxSession,
  type DshMuxChannel, type DshMuxOutboundFrame, type DshStreamHandle,
} from "../src/dsh/web-protocol/mux.js";
import { DshEventStream, parseEventResult } from "../src/dsh/web-protocol/events.js";
import {
  encodeUnaryError, encodeUnaryValue, parseEndpointPath, parseMuxFrame, parseUnaryRequest, wireError,
} from "../src/dsh/web-protocol/wire.js";
import { buildStreamHandlers, buildUnaryHandlers, DshEventBridge, type DshWireDeps } from "../src/dsh/web-protocol/streams.js";
import { deriveSessionRecords } from "../src/dsh/web-protocol/session-events.js";
import { EventBus } from "../src/events/event-bus.js";
import type { DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import type { SessionMeta } from "../src/sessions/types.js";

type TestDeps = DshWireDeps & { respondPermission: ReturnType<typeof vi.fn>; respondInteraction: ReturnType<typeof vi.fn> };
type Frames = DshMuxOutboundFrame[]; type Channel = { frames: Frames; closed: Array<{ code: number; reason: string }>; sink: DshMuxChannel };

/** 帧收集器：send/close 落数组，断言只看可观测输出（帧顺序、关闭码）。 */
function channel(): Channel {
  const frames: Frames = [], closed: Array<{ code: number; reason: string }> = [];
  const sink: DshMuxChannel = { send: (frame) => frames.push(frame), close: (code, reason) => closed.push({ code, reason }) };
  return { frames, closed, sink };
}

/** 最小 wire 依赖：真实投影面 + mock 宿主应答。 */
function wireDeps(): TestDeps {
  const meta = { id: "s1", cwd: "/work/proj", provider: "p", model: "m", title: "会话一", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z" } as SessionMeta;
  const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:05:00.000Z" }];
  const projection = {
    sessions: {
      list: async () => [meta], getMeta: async (id: string) => (id === "s1" ? meta : undefined),
      getTail: async (id: string) => (id === "s1" ? { ...meta, messages, hasMoreMessages: false } : undefined),
      get: async () => undefined, create: async () => meta as never,
    },
    agent: {
      run: vi.fn(async () => {}), isRunning: () => false, abort: vi.fn(() => true),
      enqueueSteering: vi.fn(async () => ({ id: "s", position: 1, reused: false })),
      enqueueFollowUp: vi.fn(async () => ({ id: "q", position: 1, reused: false })),
      listQueue: async () => [], updateQueue: vi.fn(async () => undefined), removeQueue: vi.fn(async () => false),
    },
    defaultCwd: "/work/default",
  } as unknown as DshProjectionDeps;
  return { projection, events: new EventBus(), home: "/home/tester", respondPermission: vi.fn(async () => {}), respondInteraction: vi.fn(async () => {}), logger: { warn: () => {} } } as never;
}

function openStream(session: DshMuxSession, endpoint: string, streamId = "s1", args: Record<string, unknown> = {}): void {
  session.handleText(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
}

/** 真实端点表 + 真实投影依赖（不经假解析器）。 */
function realStreams(): { deps: TestDeps; bridge: DshEventBridge; frames: Frames; session: DshMuxSession } {
  const deps = wireDeps();
  const bridge = new DshEventBridge(deps); const streams = buildStreamHandlers(deps, bridge);
  const { frames, sink } = channel();
  return { deps, bridge, frames, session: new DshMuxSession(sink, (endpoint) => streams.get(endpoint)) };
}

/** $events 下行帧里的 emit 事件（其余帧类型与本题无关）。 */
function emits(frames: Frames): Array<{ type: string; event: string; args: unknown[] }> {
  const values = frames.filter((frame) => frame.type === "item").map((frame) => (frame as { value?: { type?: string } }).value);
  return values.filter((value): value is { type: string; event: string; args: unknown[] } => value?.type === "emit");
}

describe("dsh unary 信封与端点路径", () => {
  it("parseUnaryRequest 取 args、异常一律 bad-request 且带 rpcId；响应编码只认 /api/<ns>/<method>", () => {
    const call = (body: unknown, method: string): unknown => parseUnaryRequest(JSON.stringify(body), method); expect(call({ type: "client-request", rpcId: "r1", method: "session/list", payload: { args: { _request: { cursor: "c" } } } }, "session/list"))
      .toEqual({ request: { rpcId: "r1", method: "session/list", args: { _request: { cursor: "c" } } } });
    expect(call({ type: "client-request", rpcId: "r2", method: "ws/follow", payload: {} }, "ws/follow")).toEqual({ request: { rpcId: "r2", method: "ws/follow", args: {} } });
    const mismatch = JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/other", payload: { args: {} } });
    // 非法 JSON / 信封类型不对 / path 与 method 不一致 / 端点段非法 一律拒绝
    const rejects = ["{", JSON.stringify({ type: "nope" }), mismatch, JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/bad*", payload: { args: {} } })];
    for (const raw of rejects) expect(parseUnaryRequest(raw, raw.includes("bad*") ? "session/bad*" : "session/list")).toMatchObject({ error: { code: "gateway/bad-request" } }); expect(parseUnaryRequest(mismatch, "session/list")).toMatchObject({ rpcId: "r1" }); // 失败仍带 rpcId，客户端才归得了位
    expect(JSON.parse(encodeUnaryValue("r2", { accepted: true }))).toMatchObject({ type: "server-response", rpcId: "r2", result: { ok: true, value: { accepted: true } } });
    expect(JSON.parse(encodeUnaryError("r2", wireError("gateway/method-unavailable", "未实现", { endpoint: "x/y" })))).toMatchObject({ result: { ok: false, error: { code: "gateway/method-unavailable", message: "未实现", details: { endpoint: "x/y" } } } });
    expect([parseEndpointPath("/api/session/list"), parseEndpointPath("/api/$events/result")]).toEqual([{ endpoint: "session/list" }, { endpoint: "$events/result" }]);
    for (const bad of ["/api/session", "/api/a/b/c", "/plugins/x/client.js"]) expect(parseEndpointPath(bad)).toBeUndefined();
  });
});
describe("dsh 逻辑流复用", () => {
  it("open 派发到端点实现：item/end 顺序、未知端点 method-unavailable、undefined 值不发 value 键、端点抛错 gateway/internal", () => {
    const ok = channel();
    const okSession = new DshMuxSession(ok.sink, (endpoint) => (endpoint === "session/control" ? (handle) => { handle.send({ type: "baseline" }); handle.end(); } : undefined));
    openStream(okSession, "session/control"); expect(ok.frames).toEqual([{ type: "item", streamId: "s1", value: { type: "baseline" } }, { type: "end", streamId: "s1" }]); expect(okSession.streamCount).toBe(0);
    const mixed = channel();
    const mixedSession = new DshMuxSession(mixed.sink, (endpoint) => {
      if (endpoint === "nope") return undefined;
      return endpoint === "boom" ? () => { throw new Error("炸了"); } : (handle) => { handle.send(undefined); };
    });
    openStream(mixedSession, "nope", "s0");
    openStream(mixedSession, "boom", "s1");
    openStream(mixedSession, "ok", "s2"); expect(mixed.frames.map((frame) => (frame.type === "error" ? frame.error.code : frame.type))).toEqual(["gateway/method-unavailable", "gateway/internal", "item"]); expect(mixed.frames[1]).toMatchObject({ streamId: "s1", error: { message: "炸了" } });
    expect(mixed.frames[2]).toEqual({ type: "item", streamId: "s2" });
  });

  it("流生命周期边界：重复 streamId/非法帧/二进制关闭、配额只回错不断连、cancel 幂等、dispose 清空", () => {
    const dup = channel();
    let cleaned = 0;
    const dupSession = new DshMuxSession(dup.sink, (endpoint) => (endpoint === "session/control" ? (handle) => { handle.onCancel(() => { cleaned++; }); } : undefined));
    openStream(dupSession, "nope", "s1");
    openStream(dupSession, "session/control", "s2");
    openStream(dupSession, "session/control", "s2"); expect(dup.frames.map((frame) => (frame.type === "error" ? frame.error.code : frame.type))).toEqual(["gateway/method-unavailable", "gateway/bad-request"]); expect(dup.closed).toEqual([{ code: DSH_CLOSE_PROTOCOL, reason: "duplicate streamId: s2" }]);
    expect(cleaned).toBe(1);
    openStream(dupSession, "session/control", "s3"); expect(dupSession.streamCount).toBe(0); // 断连后不再处理该连接的帧
    for (const raw of ["not json", '{"type":"open","streamId":"s1","endpoint":"session/control","payload":{"args":{},"extra":1}}']) {
      const invalid = channel();
      new DshMuxSession(invalid.sink, () => () => {}).handleText(raw); expect([invalid.frames, invalid.closed]).toEqual([[], [{ code: DSH_CLOSE_PROTOCOL, reason: "invalid stream frame" }]]);
    }
    const binary = channel();
    new DshMuxSession(binary.sink, () => () => {}).handleBinary(); expect(binary.closed[0]?.code).toBe(1003);
    const quota = channel();
    const quotaSession = new DshMuxSession(quota.sink, () => (handle) => { void handle; });
    for (let index = 0; index < DSH_MAX_STREAMS_PER_CONNECTION; index++) openStream(quotaSession, "session/control", `s${index}`);
    openStream(quotaSession, "session/control", "over");
    // 配额是资源问题而非协议违规：只回错误帧，不断开物理连接，cancel 释放后可再开
    expect([quotaSession.streamCount, quota.closed]).toEqual([DSH_MAX_STREAMS_PER_CONNECTION, []]); expect(quota.frames).toEqual([expect.objectContaining({ type: "error", streamId: "over", error: expect.objectContaining({ code: "gateway/bad-request" }) })]);
    quotaSession.cancel("s0");
    openStream(quotaSession, "session/control", "again"); expect(quotaSession.streamCount).toBe(DSH_MAX_STREAMS_PER_CONNECTION);
    const idle = channel();
    let cancels = 0;
    let handleRef: DshStreamHandle | undefined;
    const cancelSession = new DshMuxSession(idle.sink, () => (handle) => { handle.onCancel(() => { cancels++; }); handleRef = handle; });
    openStream(cancelSession, "session/follow", "f1");
    cancelSession.handleText(JSON.stringify({ type: "cancel", streamId: "f1" }));
    cancelSession.handleText(JSON.stringify({ type: "cancel", streamId: "f1" })); expect([cancels, cancelSession.streamCount, idle.frames.length, handleRef?.endpoint, handleRef?.cancelled]).toEqual([1, 0, 0, "session/follow", true]);
    const last = channel();
    let disposed = 0;
    const disposeSession = new DshMuxSession(last.sink, () => (handle) => { handle.onCancel(() => { disposed++; }); });
    openStream(disposeSession, "session/follow", "a");
    openStream(disposeSession, "session/follow", "b");
    disposeSession.dispose(); expect([disposed, disposeSession.streamCount]).toEqual([2, 0]);
    // 合法帧取 args（无参端点也是 {args:{}}）；payload 键集合或形状不符一律 undefined
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"session/follow","payload":{"args":{"request":{}}}}')).toEqual({ type: "open", streamId: "s", endpoint: "session/follow", args: { request: {} } });
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"$events","payload":{"args":{}}}')).toEqual({ type: "open", streamId: "s", endpoint: "$events", args: {} }); expect(parseMuxFrame('{"type":"cancel","streamId":"s"}')).toEqual({ type: "cancel", streamId: "s" });
    const malformed = [
      '{"type":"open","streamId":"","endpoint":"a/b","payload":{"args":{}}}', '{"type":"open","streamId":"s","endpoint":"a/b"}',
      '{"type":"open","streamId":"s","endpoint":"a/b","payload":{"args":{},"extra":1}}', '{"type":"open","streamId":"s","endpoint":"a/b","payload":{"args":[]}}',
      '{"type":"open","streamId":"s","endpoint":"a/b","payload":{}}', '{"type":"item","streamId":"s"}',
    ];
    for (const raw of malformed) expect(parseMuxFrame(raw), raw).toBeUndefined();
  });
});
/** 起一条 $events 流并派发一次交互请求，返回应答回路入口。 */
async function interactionStream(kind: string, payload: Record<string, unknown> = {}) {
  const { deps, bridge, frames, session } = realStreams();
  openStream(session, "$events", "ev");
  await vi.waitFor(() => expect(frames.length).toBe(1));
  const clientId = (frames[0] as { value: { clientId: string } }).value.clientId;
  deps.events.publish({ source: "agent", type: "interaction.requested", sessionId: "s1", payload: { id: "int-1", kind, prompt: "问", ...payload } });
  await vi.waitFor(() => expect(frames.length).toBe(2));
  return { deps, bridge, clientId, waterfall: (frames[1] as { value: { eventId: string; request: Record<string, unknown> } }).value };
}
describe("dsh 真实逻辑流端点与 $events 回路", () => {
  it("session/control 回 Host 级基线（覆盖全部会话、asOfSeq = 末条记录 seq）；follow 子代理如实报不支持", async () => {
    const control = realStreams();
    openStream(control.session, "session/control", "ctl");
    await vi.waitFor(() => expect(control.frames.length).toBeGreaterThan(0)); expect(control.frames[0]).toMatchObject({ type: "item", streamId: "ctl", value: { type: "baseline", value: { jobs: {} } } });
    // 1 条 user 消息投影为 5 条记录，0 基水位即 4
    const value = (control.frames[0] as { value: { value: { projections: Record<string, unknown> } } }).value.value; expect([Object.keys(value.projections), value.projections.s1]).toEqual([["s1"], expect.objectContaining({ asOfSeq: 4 })]); expect(control.frames.some((frame) => frame.type === "error")).toBe(false);
    const follow = realStreams();
    openStream(follow.session, "session/follow", "f1", { request: { address: { kind: "subagent", parentSessionId: "s1", childSessionId: "s2", mode: "one-shot" } } });
    await vi.waitFor(() => expect(follow.frames.length).toBeGreaterThan(0)); expect(follow.frames[0]).toMatchObject({ type: "error", error: { code: "gateway/bad-request" } });
  });

  it("提问 waterfall 形状 + answers 按交互 kind 全量映射；多余答案按 id 归位并记日志", async () => {
    const multi = await interactionStream("multi_select", { title: "选择", options: [{ id: "opt-0", label: "A" }, { id: "opt-1", label: "B", description: "第二个" }] }); expect(multi.waterfall).toMatchObject({ event: "user-questions/request", agentId: "s1",
      request: { questions: [{ id: "int-1", question: "问", header: "选择", options: [{ label: "A" }, { label: "B", description: "第二个" }], multiSelect: true }] } });
    await multi.bridge.resolveResult({ clientId: multi.clientId, eventId: multi.waterfall.eventId, outcome: { kind: "result", value: { answers: [{ id: "int-1", selected: ["A", "B"], custom: "再加一个" }] } } });
    // select 类交互收「选项 label 数组 + other:<自定义文本>」：custom 与多项都不能丢
    await vi.waitFor(() => expect(multi.deps.respondInteraction).toHaveBeenCalledWith("s1", "int-1", ["A", "B", "other:再加一个"]));
    // 无 id 的单条答案按唯一答案接受；各 kind 的 owc 应答形状
    const cases: Array<[string, Array<Record<string, unknown>>, unknown]> = [
      ["confirm", [{ selected: [], custom: "是" }], true], ["confirm", [{ selected: [], custom: "no" }], false], ["text", [{ selected: [], custom: "随便说说" }], "随便说说"],
      ["plan_approval", [{ selected: [], custom: "approve" }], { decision: "approve" }], ["plan_approval", [{ selected: ["不要这么做"] }], { decision: "reject", feedback: "不要这么做" }],
    ];
    for (const [kind, answers, expected] of cases) {
      const run = await interactionStream(kind);
      await run.bridge.resolveResult({ clientId: run.clientId, eventId: run.waterfall.eventId, outcome: { kind: "result", value: { answers } } });
      await vi.waitFor(() => expect(run.deps.respondInteraction).toHaveBeenCalledWith("s1", "int-1", expected));
    }
    const extra = await interactionStream("single_select", { options: [{ id: "opt-0", label: "A" }] });
    const warnings: string[] = [];
    (extra.deps as { logger: { warn(message: string): void } }).logger = { warn: (message) => warnings.push(message) };
    // 第二条答案不对应任何 owc 交互（只问了一题）：按 id 取一条，多余的不静默接受
    await extra.bridge.resolveResult({ clientId: extra.clientId, eventId: extra.waterfall.eventId, outcome: { kind: "result", value: { answers: [{ id: "int-other", selected: ["Z"] }, { id: "int-1", selected: ["A"] }] } } });
    await vi.waitFor(() => expect(extra.deps.respondInteraction).toHaveBeenCalledWith("s1", "int-1", ["A"])); expect(warnings.some((line) => line.includes("多余答案"))).toBe(true);
  });

  it("连接代：ready 一次性、emit 透传、waterfall 与 $events/result 配对、cancel 回落 rejected、dispose 回落 next", () => {
    const frames: Array<Record<string, unknown>> = [];
    const stream = new DshEventStream("/home/u", (frame) => frames.push(frame as Record<string, unknown>));
    stream.start();
    stream.start();
    stream.emit("api-session/status", ["s1", true]);
    let outcome: unknown;
    const eventId = stream.request("approval/request", "s1", { toolName: "bash" }, (value) => { outcome = value; }); expect(stream.resolveResult({ clientId: "other", eventId, outcome: { kind: "next" } })).toBe(false); // clientId 不匹配不认领
    expect(stream.resolveResult({ clientId: stream.clientId, eventId, outcome: { kind: "result", value: "allowed-once" } })).toBe(true); expect([outcome, stream.pendingCount]).toEqual([{ kind: "result", value: "allowed-once" }, 0]);
    let cancelled: unknown;
    const cancelId = stream.request("user-questions/request", "s1", { questions: [] }, (value) => { cancelled = value; });
    stream.cancel(cancelId, "会话已停止"); expect([cancelled, frames.at(-1)]).toEqual([{ kind: "rejected", error: { name: "CancelledError", message: "会话已停止" } }, { type: "cancel", eventId: cancelId }]);
    const disposing = new DshEventStream("/home/u", () => {});
    const outcomes: unknown[] = [];
    disposing.request("approval/request", "s1", {}, (value) => outcomes.push(value));
    disposing.request("user-questions/request", "s2", {}, (value) => outcomes.push(value));
    disposing.dispose();
    // 断连不是「被拒绝」：回落 next 让 owc 侧自己收尾
    expect([outcomes, disposing.pendingCount]).toEqual([[{ kind: "next" }, { kind: "next" }], 0]); expect(frames.map((frame) => frame.type)).toEqual(["ready", "emit", "waterfall", "waterfall", "cancel"]); expect(frames[0]).toMatchObject({ clientId: stream.clientId, host: { home: "/home/u" } });
    expect(frames[1]).toEqual({ type: "emit", event: "api-session/status", args: ["s1", true] }); expect(frames[2]).toEqual({ type: "waterfall", event: "approval/request", eventId, agentId: "s1", request: { toolName: "bash" } });
    // $events/result：三种 outcome 各自放行，键集合必须精确
    const ok = (outcome: unknown): unknown => parseEventResult({ clientId: "c", eventId: "e", outcome });
    const rejection = { name: "E", message: "m", code: "x", details: { a: 1 } }; expect(ok({ kind: "next" })).toEqual({ result: { clientId: "c", eventId: "e", outcome: { kind: "next" } } }); expect(ok({ kind: "result" })).toEqual({ result: { clientId: "c", eventId: "e", outcome: { kind: "result" } } });
    expect(ok({ kind: "rejected", error: rejection })).toEqual({ result: { clientId: "c", eventId: "e", outcome: { kind: "rejected", error: rejection } } });
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ clientId: "c", eventId: "e", outcome: { kind: "next", value: 1 } }, "额外字段"],
      [{ clientId: "c", eventId: "e", outcome: { kind: "rejected", error: { name: "E" } } }, "name/message"],
      [{ clientId: "c", eventId: "e", outcome: { kind: "wat" } }, "next/result/rejected"],
      [{ clientId: "c", eventId: "e", outcome: { kind: "next" }, extra: 1 }, "恰好含"],
    ];
    for (const [args, fragment] of malformed) expect((parseEventResult(args) as { error: string }).error, fragment).toContain(fragment);
  });

  it("session/prompt 不等待整轮（run 未 resolve 即返回 accepted）且后台失败不外泄；assistant/message 带 source、事件映射到 $events", async () => {
    const pending = wireDeps();
    let release: (() => void) | undefined;
    (pending.projection.agent.run as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    const projected = await buildUnaryHandlers(pending).get("session/prompt")!({ request: { sessionId: "s1", content: [{ type: "text", text: "你好" }] } }); expect(projected).toMatchObject({ value: { accepted: true } });
    release?.();
    const failing = wireDeps();
    const warnings: string[] = [];
    (failing.projection as unknown as { logger: { warn(message: string): void } }).logger = { warn: (message) => warnings.push(message) };
    (failing.projection.agent.run as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed"));
    const accepted = await buildUnaryHandlers(failing).get("session/prompt")!({ request: { sessionId: "s1", content: [{ type: "text", text: "你好" }] } });
    // 失败必须留在后台（REST 202 语义），只记日志而不是变成 RPC 错误
    expect(accepted).toMatchObject({ value: { accepted: true } });
    await vi.waitFor(() => expect(warnings.some((line) => line.includes("fetch failed"))).toBe(true));
    const records = deriveSessionRecords([{ id: "a1", role: "assistant", content: [{ type: "text", text: "回复" }], createdAt: "2026-01-01T00:00:00.000Z" }], { provider: "mock", model: "mock-chat" }).records;
    const message = records.find((record) => record.event.type === "assistant/message")!;
    // vendor messageRoute 直接读 source.provider/model 的 .length，缺失即整条渲染抛错
    expect(message.event.data).toMatchObject({ message: { source: { kind: "model", provider: "mock", model: "mock-chat" } } });
    const { deps, frames, session } = realStreams();
    openStream(session, "$events", "ev");
    await vi.waitFor(() => expect(frames.length).toBe(1));
    deps.events.publish({ source: "agent", type: "agent.error", sessionId: "s1", payload: { message: "fetch failed", retryable: false } });
    deps.events.publish({ source: "session", type: "session.deleted", sessionId: "s1", payload: {} });
    // UI 错误位与侧边栏条目收敛都必须收到事件，否则要等刷新
    await vi.waitFor(() => expect(emits(frames)).toContainEqual({ type: "emit", event: "api-session/removed", args: ["s1"] })); expect(emits(frames)).toContainEqual({ type: "emit", event: "api-session/error", args: ["s1", "fetch failed"] });
  });
});
