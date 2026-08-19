/**
 * 服务商连接测试（POST /api/provider-profiles/test 的实现）。
 *
 * 对表单中的候选配置（未持久化）做一次最小化认证请求，用于在保存前验证
 * Base URL 与 API Key 是否可用：
 * - openai-chat-completions / openai-responses：GET {baseURL}/models（免费端点）
 * - anthropic-messages：GET {baseURL}/v1/models?limit=1（免费端点；
 *   不做 POST /v1/messages 的 1-token ping，避免产生计费 token）
 *
 * 边界：5 秒超时、不跟随重定向（redirect: manual）、不读取响应体
 * （仅按状态码分类，响应体直接取消，天然不受响应大小影响）。
 * 状态码分类与 providers/provider-error.ts 的语义对齐。
 */
import { getUserAgent } from "./user-agent.js";
import { withTimeout } from "./http-utils.js";
import type { ModelProviderProfile } from "./provider-profiles.js";

const PROVIDER_TEST_TIMEOUT_MS = 5000;

type ProviderConnectionTestResult =
  | { ok: true; latencyMs: number; note?: string }
  | { ok: false; error: string };

const DEFAULT_BASE_URL: Record<ModelProviderProfile["interfaceType"], string> = {
  "anthropic-messages": "https://api.anthropic.com",
  "openai-chat-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
};

export async function testModelProviderConnection(
  profile: ModelProviderProfile,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderConnectionTestResult> {
  const base = (profile.baseURL ?? DEFAULT_BASE_URL[profile.interfaceType]).replace(/\/$/, "");
  const anthropic = profile.interfaceType === "anthropic-messages";
  const url = anthropic ? `${base}/v1/models?limit=1` : `${base}/models`;
  const headers: Record<string, string> = anthropic
    ? { "User-Agent": getUserAgent(), "x-api-key": profile.apiKey ?? "", "anthropic-version": "2023-06-01" }
    : { "User-Agent": getUserAgent(), ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}) };

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: withTimeout(undefined, PROVIDER_TEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) return { ok: false, error: "连接超时（5 秒无响应），请检查 Base URL 与网络" };
    return { ok: false, error: "无法连接到服务商，请检查 Base URL 与网络" };
  }
  const latencyMs = Date.now() - started;
  // 只关心状态码：取消响应体，避免把未知大小的 body 读进内存
  if (response.body) await response.body.cancel().catch(() => undefined);

  const status = response.status;
  if (status >= 200 && status < 300) return { ok: true, latencyMs };
  if (status === 401 || status === 403) return { ok: false, error: `认证失败（${status}），请检查 API Key` };
  if (status === 404) return { ok: false, error: "接口不存在（404），请检查 Base URL 是否正确" };
  // 429 说明服务可达且请求被接收，仅触发限流——视为连接成功并提示
  if (status === 429) return { ok: true, latencyMs, note: "服务可达，但当前被限流（429）" };
  if (status >= 300 && status < 400) return { ok: false, error: `服务返回重定向（${status}），请检查 Base URL（不自动跟随跳转）` };
  if (status >= 500) return { ok: false, error: `服务商内部错误（${status}），请稍后重试` };
  return { ok: false, error: `服务返回异常状态（${status}）` };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
