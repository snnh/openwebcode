import type { ChatMessage } from "../sessions/types.js";
import { getUserAgent } from "../user-agent.js";
import { classifyHttpError, parseRetryAfter, ProviderError, truncateErrorDetail } from "./provider-error.js";

/** OpenAI 系 provider 共用的请求头：JSON + UA + 可选 Bearer。 */
export function providerRequestHeaders(apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": getUserAgent(),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** 非 2xx/无 body 时抛出分类后的 ProviderError；错误体截断后再进消息（随后会广播进 WS 事件流）。
 * 通过返回 body 让调用点保留非空收窄（response.body 类型可空）。 */
export async function requireResponseBody(response: Response, label: string): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || !response.body) {
    const detail = truncateErrorDetail(await response.text());
    throw classifyHttpError(
      response.status,
      `${label} returned ${response.status}: ${detail}`,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return response.body;
}

/** tool_call 与 tool_result 配对的 outputs 收集前奏：toolCallId → 首个 result 文本。 */
export function collectToolOutputs(messages: ChatMessage[]): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && !outputs.has(block.toolCallId)) outputs.set(block.toolCallId, block.content);
    }
  }
  return outputs;
}

/** 同一响应内已入账的 tool_call id（调用方按响应新建：跨轮复用同 id 是上游允许的形态，
 *  去重只在一次响应（一条 assistant 消息）内生效）。 */
export type ToolCallIdRegistry = Set<string>;

/**
 * tool_call id 登记（主循环/子代理/chat 模式共用）：**一次响应内**重复 id 只认首个。
 *
 * 一个 tool_use 只能有一个 tool_result，重复 id 会让下一次请求被端点拒绝——Anthropic 报
 * 「each tool_use must have a single result. Found multiple `tool_result` blocks with id」，
 * OpenAI 系报重复 tool_call_id。上游复读同一调用（网关重发 content_block、配对派生 id 撞车）
 * 时按首个保留，吞掉后续重复块并留痕：与回放层同 id 去重（anthropic `emittedCallIds`、
 * responses/compatible `emitted`）同口径，保证「活动路径上一个 id 一份结果」从落盘起就成立。
 * 调用方按响应新建 registry（跨轮复用 id 属合法形态，不跨消息去重）；
 * 返回 true 表示本响应首个该 id——调用方据此决定是否落盘调用块与执行。
 */
export function recordToolCallId(seen: ToolCallIdRegistry, id: string, name: string, label: string): boolean {
  if (seen.has(id)) {
    process.stderr.write(
      `[${label}] 丢弃重复 tool_call id=${id}（${name}）：同一 tool_use 只能有一份结果，重复会让下一次 provider 请求 400\n`,
    );
    return false;
  }
  seen.add(id);
  return true;
}

/** 工具调用参数 JSON 解析：失败多为流被 max_tokens 截断，属确定性错误（不可重试，
 * 否则 collectProviderTurn 会按 stream_interrupted 白重试）。 */
export function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch (error) {
    throw new ProviderError(
      "invalid_request",
      `Tool call arguments are not valid JSON (the stream may have been truncated): ${error instanceof Error ? error.message : String(error)}`,
      false,
      undefined,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderError("invalid_request", "Tool arguments must be an object", false);
  }
  return parsed as Record<string, unknown>;
}
