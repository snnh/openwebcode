import type { ChatMessage } from "../sessions/types.js";
import { getUserAgent } from "../http.js";
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
