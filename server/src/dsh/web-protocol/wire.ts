/**
 * dsh Typert Remote 的 wire 编解码（M4 翻译层，协议面权威来源见 docs/dsh-wire-contract.md）。
 *
 * unary：
 *   POST /api/<namespace>/<method>
 *   { type: "client-request", rpcId, method: "<ns>/<method>", payload: { args: { … } } }
 *   → { type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * 生成的 strict 描述符里业务参数是**单个 request 字段**（`args.request`；`session/list` 为 `args._request`）。
 * 本模块只做信封与端点解析，不做业务投影（投影见 session-projection.ts）。
 */

/** dsh 侧固定 RPC 前缀（根绝对路径；独立端口方案下与 owc 主端口无关）。 */
const DSH_API_PREFIX = "/api";

/** 唯一逻辑流复用通道路径。 */
export const DSH_MUX_PATH = "/api/remote.mux";

/** 连接代事件流端点名。 */
export const DSH_EVENTS_STREAM = "$events";

/** waterfall 应答端点（unary）。 */
export const DSH_EVENTS_RESULT = "$events/result";

/** wire 错误（`{ code, message, details }`，码表见 dsh 的 remote-error-codes.ts）。 */
export interface DshWireError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** unary 请求信封。 */
export interface DshUnaryRequest {
  rpcId: string;
  method: string;
  args: Record<string, unknown>;
}

/** unary 成功/失败响应信封。 */
export function encodeUnaryValue(rpcId: string, value: unknown): string {
  return JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } });
}

export function encodeUnaryError(rpcId: string, error: DshWireError): string {
  return JSON.stringify({ type: "server-response", rpcId, result: { ok: false, error } });
}

/** 构造 wire 错误（默认 details 为空对象：上游 schema 要求 object）。 */
export function wireError(code: string, message: string, details: Record<string, unknown> = {}): DshWireError {
  return { code, message, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 端点段白名单（与 dsh 的 rpc-host 约束一致）。 */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/**
 * 解析 unary 请求体：JSON、信封形状、方法一致性与端点段白名单。
 * 失败返回 wire 错误（`gateway/bad-request` 等），调用方按信封回错。
 */
export function parseUnaryRequest(raw: string, pathMethod: string): { request: DshUnaryRequest } | { error: DshWireError; rpcId?: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: wireError("gateway/bad-request", "请求体不是合法 JSON", { endpoint: pathMethod }) };
  }
  if (!isRecord(body) || body.type !== "client-request") {
    return { error: wireError("gateway/bad-request", "请求信封缺少 type=client-request", { endpoint: pathMethod }) };
  }
  const rpcId = typeof body.rpcId === "string" ? body.rpcId : undefined;
  if (rpcId === undefined) return { error: wireError("gateway/bad-request", "请求信封缺少 rpcId", { endpoint: pathMethod }) };
  const method = typeof body.method === "string" ? body.method : "";
  if (method !== pathMethod) {
    return { error: wireError("gateway/bad-request", `path 与 body.method 不一致：${pathMethod} ≠ ${method}`, { endpoint: pathMethod }), rpcId };
  }
  for (const segment of method.split("/")) {
    if (!ENDPOINT_SEGMENT.test(segment)) {
      return { error: wireError("gateway/bad-request", `端点段非法：${segment}`, { endpoint: pathMethod }), rpcId };
    }
  }
  const payload = isRecord(body.payload) ? body.payload : {};
  const args = isRecord(payload.args) ? payload.args : {};
  return { request: { rpcId, method, args } };
}

/**
 * 从 URL path 解析端点：只接受 `/api/<ns>/<method>`（本翻译层不实现多段子路径端点）。
 * 返回 undefined 表示路径不在 `/api/` 前缀内或形状不符。
 */
export function parseEndpointPath(urlPath: string): { endpoint: string } | undefined {
  if (!urlPath.startsWith(`${DSH_API_PREFIX}/`)) return undefined;
  const rest = urlPath.slice(DSH_API_PREFIX.length + 1);
  const segments = rest.split("/");
  if (segments.length !== 2) return undefined;
  const [namespace, method] = segments;
  if (namespace === undefined || method === undefined) return undefined;
  if (!ENDPOINT_SEGMENT.test(namespace) || !ENDPOINT_SEGMENT.test(method)) return undefined;
  return { endpoint: `${namespace}/${method}` };
}

/** 逻辑流帧（Host → 客户端）。 */
export type DshMuxOutboundFrame =
  | { type: "item"; streamId: string; value?: unknown }
  | { type: "error"; streamId: string; error: DshWireError }
  | { type: "end"; streamId: string };

/** 逻辑流帧（客户端 → Host）。 */
export type DshMuxInboundFrame =
  | { type: "open"; streamId: string; endpoint: string; args: Record<string, unknown> }
  | { type: "cancel"; streamId: string };

/** 解析客户端逻辑流帧；形状非法返回 undefined（调用方按协议违规 close(1008)）。 */
export function parseMuxFrame(raw: string): DshMuxInboundFrame | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(body) || typeof body.streamId !== "string" || body.streamId === "") return undefined;
  if (body.type === "cancel") return { type: "cancel", streamId: body.streamId };
  if (body.type !== "open") return undefined;
  if (typeof body.endpoint !== "string" || body.endpoint === "") return undefined;
  for (const segment of body.endpoint.split("/")) {
    if (!ENDPOINT_SEGMENT.test(segment)) return undefined;
  }
  const payload = isRecord(body.payload) ? body.payload : {};
  const args = isRecord(payload.args) ? payload.args : {};
  return { type: "open", streamId: body.streamId, endpoint: body.endpoint, args };
}
