/** dsh 翻译层骨架单测：wire 信封、逻辑流复用、$events 连接代状态、真实端点（非假解析器）。 */
import { describe, expect, it, vi } from "vitest";
import {
  DSH_CLOSE_PROTOCOL,
  DshMuxSession,
  type DshMuxChannel,
  type DshMuxOutboundFrame,
  type DshStreamHandle,
} from "../src/dsh/web-protocol/mux.js";
import { DshEventStream, parseEventResult } from "../src/dsh/web-protocol/events.js";
import {
  encodeUnaryError,
  encodeUnaryValue,
  parseEndpointPath,
  parseMuxFrame,
  parseUnaryRequest,
  wireError,
} from "../src/dsh/web-protocol/wire.js";
import { buildStreamHandlers, DshEventBridge, type DshWireDeps } from "../src/dsh/web-protocol/streams.js";
import { buildUnaryHandlers } from "../src/dsh/web-protocol/streams.js";
import { deriveSessionRecords } from "../src/dsh/web-protocol/session-events.js";
import { EventBus } from "../src/events/event-bus.js";
import type { DshProjectionDeps } from "../src/dsh/web-protocol/session-projection.js";
import type { SessionMeta } from "../src/sessions/types.js";

function channel(): { frames: DshMuxOutboundFrame[]; closed: Array<{ code: number; reason: string }>; sink: DshMuxChannel } {
  const frames: DshMuxOutboundFrame[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return { frames, closed, sink: { send: (frame) => frames.push(frame), close: (code, reason) => closed.push({ code, reason }) } };
}

/** 最小 wire 依赖（真实投影面 + mock 宿主应答），供真实端点表使用。 */
function wireDeps(): DshWireDeps & { respondInteraction: ReturnType<typeof vi.fn>; events: EventBus } {
  const metas = [{
    id: "s1",
    cwd: "/work/proj",
    provider: "p",
    model: "m",
    title: "会话一",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
  } as SessionMeta];
  const projection = {
    sessions: {
      list: async () => metas,
      getMeta: async (id: string) => metas.find((entry) => entry.id === id),
      getTail: async (id: string) => (id === "s1"
        ? { ...metas[0], messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "2026-01-01T00:05:00.000Z" }], hasMoreMessages: false }
        : undefined),
      get: async () => undefined,
      create: async () => metas[0] as never,
    },
    agent: {
      run: vi.fn(async () => {}),
      isRunning: () => false,
      abort: vi.fn(() => true),
      enqueueSteering: vi.fn(async () => ({ id: "s", position: 1, reused: false })),
      enqueueFollowUp: vi.fn(async () => ({ id: "q", position: 1, reused: false })),
      listQueue: async () => [],
      updateQueue: vi.fn(async () => undefined),
      removeQueue: vi.fn(async () => false),
    },
    defaultCwd: "/work/default",
  } as unknown as DshProjectionDeps;
  return {
    projection,
    events: new EventBus(),
    home: "/home/tester",
    respondPermission: vi.fn(async () => {}),
    respondInteraction: vi.fn(async () => {}),
    logger: { warn: () => {} },
  } as never;
}

describe("dsh 会话主路径的实机缺陷回归", () => {
  it("session/prompt 不等待整轮：agent.run 未被 await（与 REST 202 语义一致）", async () => {
    const deps = wireDeps();
    const handlers = buildUnaryHandlers(deps);
    let release: (() => void) | undefined;
    // run 永不 resolve（模拟长回合/等待审批）：prompt 必须立刻返回 accepted
    (deps.projection.agent.run as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve(); }),
    );
    const started = Date.now();
    const projected = await handlers.get("session/prompt")!({
      request: { sessionId: "s1", content: [{ type: "text", text: "你好" }] },
    });
    expect(projected).toMatchObject({ value: { accepted: true } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(deps.projection.agent.run).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("session/prompt 的后台 run 失败不外泄为 RPC 错误（走日志 + agent.error 事件）", async () => {
    const deps = wireDeps();
    const warn = vi.fn();
    (deps as { projection: DshProjectionDeps }).projection.logger = { warn };
    (deps.projection.agent.run as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed"));
    const handlers = buildUnaryHandlers(deps);
    const projected = await handlers.get("session/prompt")!({
      request: { sessionId: "s1", content: [{ type: "text", text: "你好" }] },
    });
    expect(projected).toMatchObject({ value: { accepted: true } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it("assistant/message 带 source.provider/model（vendor messageRoute 直接读 .length，缺失即整条渲染抛错）", () => {
    const records = deriveSessionRecords(
      [{ id: "a1", role: "assistant", content: [{ type: "text", text: "回复" }], createdAt: "2026-01-01T00:00:00.000Z" }],
      { provider: "mock", model: "mock-chat" },
    ).records;
    const message = records.find((record) => record.event.type === "assistant/message")!;
    const data = message.event.data as { message: { source: { kind: string; provider: string; model: string } }; stream: unknown[] };
    expect(data.message.source).toEqual({ kind: "model", provider: "mock", model: "mock-chat" });
    expect(Array.isArray(data.stream)).toBe(true);
  });

  it("agent.error → api-session/error、session.deleted → api-session/removed（UI 的错误位与侧边栏收敛）", () => {
    const deps = wireDeps();
    const bridge = new DshEventBridge(deps);
    const streams = buildStreamHandlers(deps, bridge);
    const { frames, sink } = channel();
    const mux = new DshMuxSession(sink, (endpoint) => streams.get(endpoint));
    mux.handleText(JSON.stringify({ type: "open", streamId: "1", endpoint: "$events", payload: { args: {} } }));
    deps.events.publish({ source: "agent", type: "agent.error", sessionId: "s1", payload: { message: "fetch failed", retryable: false } });
    deps.events.publish({ source: "session", type: "session.deleted", sessionId: "s1", payload: {} });
    const emits = frames.filter((frame) => frame.type === "item" && (frame as { value?: { type?: string } }).value?.type === "emit")
      .map((frame) => (frame as unknown as { value: { type: string; event: string; args: unknown[] } }).value);
    expect(emits).toContainEqual({ type: "emit", event: "api-session/error", args: ["s1", "fetch failed"] });
    expect(emits).toContainEqual({ type: "emit", event: "api-session/removed", args: ["s1"] });
  });
});

describe("dsh unary 信封", () => {
  it("解析合法请求并取 args", () => {
    const parsed = parseUnaryRequest(
      JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/list", payload: { args: { _request: { cursor: "c" } } } }),
      "session/list",
    );
    expect(parsed).toEqual({ request: { rpcId: "r1", method: "session/list", args: { _request: { cursor: "c" } } } });
  });

  it("拒绝 JSON 错误、信封缺失、path/method 不一致与非法端点段", () => {
    expect(parseUnaryRequest("{", "session/list")).toMatchObject({ error: { code: "gateway/bad-request" } });
    expect(parseUnaryRequest(JSON.stringify({ type: "nope" }), "session/list")).toMatchObject({ error: { code: "gateway/bad-request" } });
    const mismatch = parseUnaryRequest(
      JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/other", payload: { args: {} } }),
      "session/list",
    );
    expect(mismatch).toMatchObject({ error: { code: "gateway/bad-request" }, rpcId: "r1" });
    const bad = parseUnaryRequest(
      JSON.stringify({ type: "client-request", rpcId: "r1", method: "session/bad*", payload: { args: {} } }),
      "session/bad*",
    );
    expect(bad).toMatchObject({ error: { code: "gateway/bad-request" } });
  });

  it("缺省 args 视作空对象；编码响应与错误", () => {
    const parsed = parseUnaryRequest(JSON.stringify({ type: "client-request", rpcId: "r2", method: "ws/follow", payload: {} }), "ws/follow");
    expect(parsed).toEqual({ request: { rpcId: "r2", method: "ws/follow", args: {} } });
    expect(JSON.parse(encodeUnaryValue("r2", { accepted: true }))).toEqual({
      type: "server-response",
      rpcId: "r2",
      result: { ok: true, value: { accepted: true } },
    });
    expect(JSON.parse(encodeUnaryError("r2", wireError("gateway/method-unavailable", "未实现", { endpoint: "x/y" })))).toEqual({
      type: "server-response",
      rpcId: "r2",
      result: { ok: false, error: { code: "gateway/method-unavailable", message: "未实现", details: { endpoint: "x/y" } } },
    });
  });

  it("路径解析只接受 /api/<ns>/<method>", () => {
    expect(parseEndpointPath("/api/session/list")).toEqual({ endpoint: "session/list" });
    expect(parseEndpointPath("/api/$events/result")).toEqual({ endpoint: "$events/result" });
    expect(parseEndpointPath("/api/session")).toBeUndefined();
    expect(parseEndpointPath("/api/a/b/c")).toBeUndefined();
    expect(parseEndpointPath("/plugins/x/client.js")).toBeUndefined();
  });
});

describe("dsh 逻辑流复用", () => {
  it("open 派发到端点实现，item/end 帧按顺序发出", () => {
    const { frames, sink } = channel();
    const session = new DshMuxSession(sink, (endpoint) =>
      endpoint === "session/control" ? (handle) => { handle.send({ type: "baseline" }); handle.end(); } : undefined,
    );
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session/control", payload: { args: {} } }));
    expect(frames).toEqual([
      { type: "item", streamId: "s1", value: { type: "baseline" } },
      { type: "end", streamId: "s1" },
    ]);
    expect(session.streamCount).toBe(0);
  });

  it("未知端点回 method-unavailable；重复 streamId 回 bad-request 后按协议违规断连", () => {
    const { frames, closed, sink } = channel();
    let cleaned = 0;
    const session = new DshMuxSession(sink, (endpoint) => (endpoint === "session/control" ? (handle) => { handle.onCancel(() => { cleaned++; }); } : undefined));
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session/nope", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/control", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/control", payload: { args: {} } }));
    expect(frames.map((frame) => frame.type === "error" ? frame.error.code : frame.type)).toEqual([
      "gateway/method-unavailable", "gateway/bad-request",
    ]);
    // 与上游一致：重复 streamId 是协议违规 → 回错后断开物理连接并清理全部逻辑流
    expect(closed).toEqual([{ code: DSH_CLOSE_PROTOCOL, reason: "duplicate streamId: s2" }]);
    expect(cleaned).toBe(1);
    expect(session.streamCount).toBe(0);
    // 断连后不再处理该连接的后续帧
    session.handleText(JSON.stringify({ type: "open", streamId: "s3", endpoint: "session/control", payload: { args: {} } }));
    expect(session.streamCount).toBe(0);
  });

  it("cancel 触发清理回调并停止后续推送；重复 cancel 幂等", () => {
    const { frames, sink } = channel();
    let cleaned = 0;
    let handleRef: DshStreamHandle | undefined;
    const session = new DshMuxSession(sink, () => (handle) => {
      handle.onCancel(() => { cleaned++; });
      handleRef = handle;
    });
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session/follow", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "cancel", streamId: "s1" }));
    session.handleText(JSON.stringify({ type: "cancel", streamId: "s1" }));
    expect(cleaned).toBe(1);
    expect(session.streamCount).toBe(0);
    expect(frames).toHaveLength(0);
    expect(handleRef?.endpoint).toBe("session/follow");
    expect(handleRef?.cancelled).toBe(true);
  });

  it("形状非法 close(1008)、二进制 close(1003)、dispose 清理全部流", () => {
    const first = channel();
    const session = new DshMuxSession(first.sink, () => () => {});
    session.handleText("not json");
    expect(first.closed).toEqual([{ code: DSH_CLOSE_PROTOCOL, reason: "invalid stream frame" }]);

    const second = channel();
    const secondSession = new DshMuxSession(second.sink, () => () => {});
    secondSession.handleBinary();
    expect(second.closed[0]?.code).toBe(1003);

    const third = channel();
    let cleaned = 0;
    const thirdSession = new DshMuxSession(third.sink, () => (handle) => { handle.onCancel(() => { cleaned++; }); });
    thirdSession.handleText(JSON.stringify({ type: "open", streamId: "a", endpoint: "session/follow", payload: { args: {} } }));
    thirdSession.handleText(JSON.stringify({ type: "open", streamId: "b", endpoint: "session/follow", payload: { args: {} } }));
    expect(thirdSession.streamCount).toBe(2);
    thirdSession.dispose();
    expect(cleaned).toBe(2);
    expect(thirdSession.streamCount).toBe(0);
  });

  it("端点实现抛错回 gateway/internal；undefined 值不发 value 键", () => {
    const { frames, sink } = channel();
    const session = new DshMuxSession(sink, (endpoint) => endpoint === "boom"
      ? () => { throw new Error("炸了"); }
      : (handle) => { handle.send(undefined); });
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "boom", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "open", streamId: "s2", endpoint: "ok", payload: { args: {} } }));
    const [first, second] = frames;
    expect(first).toMatchObject({ type: "error", streamId: "s1", error: { code: "gateway/internal", message: "炸了" } });
    expect(second).toEqual({ type: "item", streamId: "s2" });
  });

  it("帧解析：非法形状返回 undefined，合法 open 取 payload.args（payload 严格只有 args 键）", () => {
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"session/follow","payload":{"args":{"request":{}}}}')).toEqual({
      type: "open", streamId: "s", endpoint: "session/follow", args: { request: {} },
    });
    // 无参数端点：客户端也发 {args:{}}（vendor `REMOTE_EVENT_STREAM_PAYLOAD`）
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"$events","payload":{"args":{}}}')).toEqual({
      type: "open", streamId: "s", endpoint: "$events", args: {},
    });
    expect(parseMuxFrame('{"type":"open","streamId":"","endpoint":"a/b","payload":{"args":{}}}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"a/b"}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"a/b","payload":{"args":{},"extra":1}}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"a/b","payload":{"args":[]}}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"a/b","payload":{}}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"item","streamId":"s"}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"cancel","streamId":"s"}')).toEqual({ type: "cancel", streamId: "s" });
  });

  it("open 帧形状非法（含 payload 键不合法）按协议违规 close(1008)", () => {
    const { frames, closed, sink } = channel();
    const session = new DshMuxSession(sink, () => () => {});
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session/control", payload: { args: {}, extra: 1 } }));
    expect(frames).toEqual([]);
    expect(closed).toEqual([{ code: DSH_CLOSE_PROTOCOL, reason: "invalid stream frame" }]);
  });
});

describe("dsh 真实逻辑流端点（不经假解析器）", () => {
  /** 用真实端点表 + 真实投影依赖开一条流，返回帧收集。 */
  function realStreams() {
    const deps = wireDeps();
    const bridge = new DshEventBridge(deps);
    const streams = buildStreamHandlers(deps, bridge);
    const { frames, closed, sink } = channel();
    const session = new DshMuxSession(sink, (endpoint) => streams.get(endpoint));
    return { deps, bridge, frames, closed, session };
  }

  it("session/control 无参数：open 帧 payload.args 为 {} 时仍返回 Host 级基线（不 fail）", async () => {
    const { frames, session } = realStreams();
    session.handleText(JSON.stringify({ type: "open", streamId: "ctl", endpoint: "session/control", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames[0]).toMatchObject({ type: "item", streamId: "ctl" });
    const value = (frames[0] as { value: { type: string; value: { jobs: Record<string, unknown>; projections: Record<string, unknown> } } }).value;
    expect(value.type).toBe("baseline");
    expect(value.value.jobs).toEqual({});
    // Host 级：覆盖全部会话（该端点没有 sessionId 参数，不能只给一个会话）
    expect(Object.keys(value.value.projections)).toEqual(["s1"]);
    // asOfSeq 口径 = 末条记录 seq（1 条 user 消息 → 5 条记录，seq 0 基 → 水位 4）
    expect(value.value.projections.s1).toMatchObject({ asOfSeq: 4 });
    expect(frames.some((frame) => frame.type === "error")).toBe(false);
  });

  it("session/follow 真实端点：快照帧可发，子代理地址如实报不支持", async () => {
    const { frames, session } = realStreams();
    session.handleText(JSON.stringify({ type: "open", streamId: "f1", endpoint: "session/follow", payload: { args: { request: { address: { kind: "subagent", parentSessionId: "s1", childSessionId: "s2", mode: "one-shot" } } } } }));
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames[0]).toMatchObject({ type: "error", error: { code: "session/unsupported" } });
  });

  it("$events 提问回路：answers 全量映射到 owc 交互契约（多选 + 自定义答案）", async () => {
    const { bridge, deps, frames, session } = realStreams();
    session.handleText(JSON.stringify({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBe(1));
    const clientId = (frames[0] as { value: { clientId: string } }).value.clientId;

    deps.events.publish({
      source: "agent",
      type: "interaction.requested",
      sessionId: "s1",
      payload: { id: "int-1", kind: "multi_select", title: "选择", prompt: "选哪几个", options: [{ id: "opt-0", label: "A" }, { id: "opt-1", label: "B", description: "第二个" }] },
    });
    await vi.waitFor(() => expect(frames.length).toBe(2));
    const waterfall = (frames[1] as { value: { eventId: string; request: { questions: Array<Record<string, unknown>> } } }).value;
    expect(waterfall.request.questions).toEqual([{
      id: "int-1",
      question: "选哪几个",
      header: "选择",
      options: [{ label: "A" }, { label: "B", description: "第二个" }],
      multiSelect: true,
    }]);

    const resolved = await bridge.resolveResult({
      clientId,
      eventId: waterfall.eventId,
      outcome: { kind: "result", value: { answers: [{ id: "int-1", selected: ["A", "B"], custom: "再加一个" }] } },
    });
    expect(resolved).toEqual({ value: {} });
    // owc 契约：select 类交互收「选项 label 数组 + other:<自定义文本>」，不能丢 custom/多项
    await vi.waitFor(() => expect(deps.respondInteraction).toHaveBeenCalledWith("s1", "int-1", ["A", "B", "other:再加一个"]));
  });

  it("$events 提问回路：多答案按问题 id 归位，多余答案不静默接受（记日志）", async () => {
    const deps = wireDeps();
    const warnings: string[] = [];
    deps.logger = { warn: (message: string) => warnings.push(message) };
    const bridge = new DshEventBridge(deps);
    const streams = buildStreamHandlers(deps, bridge);
    const { frames, sink } = channel();
    const session = new DshMuxSession(sink, (endpoint) => streams.get(endpoint));
    session.handleText(JSON.stringify({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } }));
    await vi.waitFor(() => expect(frames.length).toBe(1));
    const clientId = (frames[0] as { value: { clientId: string } }).value.clientId;

    deps.events.publish({ source: "agent", type: "interaction.requested", sessionId: "s1", payload: { id: "int-2", kind: "single_select", prompt: "选一个", options: [{ id: "opt-0", label: "A" }] } });
    await vi.waitFor(() => expect(frames.length).toBe(2));
    const waterfall = (frames[1] as { value: { eventId: string } }).value;
    await bridge.resolveResult({
      clientId,
      eventId: waterfall.eventId,
      // 第二条答案不对应任何 owc 交互（我们只问了一题）
      outcome: { kind: "result", value: { answers: [{ id: "int-other", selected: ["Z"] }, { id: "int-2", selected: ["A"] }] } },
    });
    await vi.waitFor(() => expect(deps.respondInteraction).toHaveBeenCalledWith("s1", "int-2", ["A"]));
    expect(warnings.some((line) => line.includes("多余答案"))).toBe(true);
  });

  it("$events 提问回路：confirm / text / plan_approval 各按 owc 契约映射", async () => {
    const cases: Array<{ kind: string; answers: Array<Record<string, unknown>>; expected: unknown }> = [
      { kind: "confirm", answers: [{ selected: [], custom: "是" }], expected: true },
      { kind: "confirm", answers: [{ selected: [], custom: "no" }], expected: false },
      { kind: "text", answers: [{ selected: [], custom: "随便说说" }], expected: "随便说说" },
      { kind: "plan_approval", answers: [{ selected: [], custom: "approve" }], expected: { decision: "approve" } },
      { kind: "plan_approval", answers: [{ selected: ["不要这么做"] }], expected: { decision: "reject", feedback: "不要这么做" } },
    ];
    for (const [index, entry] of cases.entries()) {
      const deps = wireDeps();
      const bridge = new DshEventBridge(deps);
      const streams = buildStreamHandlers(deps, bridge);
      const { frames, sink } = channel();
      const session = new DshMuxSession(sink, (endpoint) => streams.get(endpoint));
      session.handleText(JSON.stringify({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } }));
      await vi.waitFor(() => expect(frames.length).toBe(1));
      const clientId = (frames[0] as { value: { clientId: string } }).value.clientId;
      const requestId = `int-${index}`;
      deps.events.publish({ source: "agent", type: "interaction.requested", sessionId: "s1", payload: { id: requestId, kind: entry.kind, prompt: "问" } });
      await vi.waitFor(() => expect(frames.length).toBe(2));
      const waterfall = (frames[1] as { value: { eventId: string } }).value;
      await bridge.resolveResult({ clientId, eventId: waterfall.eventId, outcome: { kind: "result", value: { answers: entry.answers } } });
      await vi.waitFor(() => expect(deps.respondInteraction).toHaveBeenCalledWith("s1", requestId, entry.expected));
    }
  });
});

describe("dsh $events 连接代", () => {
  it("ready 一次性、emit 透传、waterfall 与 $events/result 配对", () => {
    const frames: unknown[] = [];
    const stream = new DshEventStream("/home/u", (frame) => frames.push(frame));
    stream.start();
    stream.start();
    stream.emit("api-session/status", ["s1", true]);
    let outcome: unknown;
    const eventId = stream.request("approval/request", "s1", { toolName: "bash" }, (value) => { outcome = value; });
    expect(stream.pendingCount).toBe(1);
    expect(parseEventResult({ clientId: stream.clientId, eventId, outcome: { kind: "result", value: "allowed-once" } })).toEqual({
      result: { clientId: stream.clientId, eventId, outcome: { kind: "result", value: "allowed-once" } },
    });
    expect(stream.resolveResult({ clientId: stream.clientId, eventId, outcome: { kind: "result", value: "allowed-once" } })).toBe(true);
    expect(outcome).toEqual({ kind: "result", value: "allowed-once" });
    expect(stream.pendingCount).toBe(0);
    expect(frames).toEqual([
      { type: "ready", clientId: stream.clientId, host: { home: "/home/u" } },
      { type: "emit", event: "api-session/status", args: ["s1", true] },
      { type: "waterfall", event: "approval/request", eventId, agentId: "s1", request: { toolName: "bash" } },
    ]);
  });

  it("cancel 通知客户端并让 owc 侧回落；clientId 不匹配返回 false", () => {
    const frames: Array<{ type: string; eventId?: string }> = [];
    const stream = new DshEventStream("/home/u", (frame) => frames.push(frame as { type: string; eventId?: string }));
    let outcome: { kind: string } | undefined;
    const eventId = stream.request("user-questions/request", "s1", { questions: [] }, (value) => { outcome = value; });
    stream.cancel(eventId, "会话已停止");
    expect(frames.at(-1)).toEqual({ type: "cancel", eventId });
    expect(outcome).toEqual({ kind: "rejected", error: { name: "CancelledError", message: "会话已停止" } });
    expect(stream.resolveResult({ clientId: "other", eventId, outcome: { kind: "next" } })).toBe(false);
  });

  it("dispose 让全部挂起请求回落为 next（不误判为拒绝）", () => {
    const stream = new DshEventStream("/home/u", () => {});
    const outcomes: unknown[] = [];
    stream.request("approval/request", "s1", {}, (value) => outcomes.push(value));
    stream.request("user-questions/request", "s2", {}, (value) => outcomes.push(value));
    stream.dispose();
    expect(outcomes).toEqual([{ kind: "next" }, { kind: "next" }]);
    expect(stream.pendingCount).toBe(0);
  });

  it("$events/result 形状校验：键集合必须精确、outcome 三种形态各自校验", () => {
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "next" } })).toEqual({
      result: { clientId: "c", eventId: "e", outcome: { kind: "next" } },
    });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "next", value: 1 } })).toMatchObject({ error: expect.stringContaining("额外字段") });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "result" } })).toEqual({
      result: { clientId: "c", eventId: "e", outcome: { kind: "result" } },
    });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "result", value: "allowed-once" } })).toEqual({
      result: { clientId: "c", eventId: "e", outcome: { kind: "result", value: "allowed-once" } },
    });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "rejected", error: { name: "E", message: "m", code: "x", details: { a: 1 } } } })).toEqual({
      result: { clientId: "c", eventId: "e", outcome: { kind: "rejected", error: { name: "E", message: "m", code: "x", details: { a: 1 } } } },
    });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "rejected", error: { name: "E" } } })).toMatchObject({ error: expect.stringContaining("name/message") });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "wat" } })).toMatchObject({ error: expect.stringContaining("next/result/rejected") });
    expect(parseEventResult({ clientId: "c", eventId: "e", outcome: { kind: "next" }, extra: 1 })).toMatchObject({ error: expect.stringContaining("恰好含") });
  });
});
