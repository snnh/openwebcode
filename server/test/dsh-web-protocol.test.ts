/** dsh 翻译层骨架单测：wire 信封、逻辑流复用、$events 连接代状态。 */
import { describe, expect, it } from "vitest";
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

function channel(): { frames: DshMuxOutboundFrame[]; closed: Array<{ code: number; reason: string }>; sink: DshMuxChannel } {
  const frames: DshMuxOutboundFrame[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return { frames, closed, sink: { send: (frame) => frames.push(frame), close: (code, reason) => closed.push({ code, reason }) } };
}

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

  it("未知端点回 method-unavailable；重复 streamId 回 bad-request", () => {
    const { frames, sink } = channel();
    const session = new DshMuxSession(sink, (endpoint) => (endpoint === "session/control" ? () => {} : undefined));
    session.handleText(JSON.stringify({ type: "open", streamId: "s1", endpoint: "session/nope", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/control", payload: { args: {} } }));
    session.handleText(JSON.stringify({ type: "open", streamId: "s2", endpoint: "session/control", payload: { args: {} } }));
    expect(frames.map((frame) => frame.type === "error" ? frame.error.code : frame.type)).toEqual([
      "gateway/method-unavailable", "gateway/bad-request",
    ]);
    expect(session.streamCount).toBe(1);
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

  it("帧解析：非法形状返回 undefined，合法 open 取 payload.args", () => {
    expect(parseMuxFrame('{"type":"open","streamId":"s","endpoint":"session/follow"}')).toEqual({
      type: "open", streamId: "s", endpoint: "session/follow", args: {},
    });
    expect(parseMuxFrame('{"type":"open","streamId":"","endpoint":"a/b"}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"item","streamId":"s"}')).toBeUndefined();
    expect(parseMuxFrame('{"type":"cancel","streamId":"s"}')).toEqual({ type: "cancel", streamId: "s" });
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
