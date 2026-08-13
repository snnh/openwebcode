/**
 * 出站 HTTP 的共享小工具：超时信号合并、受限响应体读取、手动重定向循环。
 * 收敛此前散落在 web-tools / chat-media / mcp / update-checker / http 的重复实现；
 * SSRF / origin 边界由调用方经 validate / trustedOrigin 注入，本模块只提供骨架。
 */

/** 把调用方 signal 与超时合并为单一 AbortSignal（任一触发即中止）；无调用方 signal 时仅用超时。 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 流式读取响应体并施加字节上限；超限取消读取并抛错（防失控端点打爆内存）。 */
export async function readResponseLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** 受限读取并解码为文本（空 body 返回空串）。 */
export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readResponseLimited(response, maxBytes));
}

/** 受限读取并解析 JSON；非法 JSON 抛错（字节超限错误原样透传）。 */
export async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextLimited(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Response returned invalid JSON");
  }
}

export interface FollowRedirectsOptions {
  fetchImpl: typeof fetch;
  /** 起始 URL（调用方已校验合法）；重定向目标在本循环内逐跳校验。 */
  start: URL;
  signal: AbortSignal;
  headers: Record<string, string>;
  /** 跳数上限（含起始请求），缺省 10。 */
  maxRedirects?: number;
  /** 每跳（含起始）URL 校验（SSRF 网关、DNS 复查等），可异步；抛错即中止。 */
  validate?: (url: URL) => void | Promise<void>;
  /** 非空时重定向必须留在该 origin（reader/search 端点防被 302 引向任意主机）；离开即抛错。 */
  trustedOrigin?: string;
  /** 错误消息中的服务名（如 "Search provider" / "Bing"）；缺省用通用消息。 */
  label?: string;
  /** origin 越界错误消息中的 origin 名称；缺省 "the configured origin"（reader 场景传 "the configured reader origin"）。 */
  originName?: string;
}

/**
 * redirect: manual 手动跟随循环的统一骨架：逐跳校验、Location 缺失/跳数上限/
 * origin 越界（含非 http/https 协议）即抛错，返回首个非重定向响应及其最终 URL
 * （重定向链终点；mock fetch 的 response.url 不可靠，故由本循环显式给出）。
 * 安全纪律与既有各调用点逐字一致，仅收敛重复循环。
 */
export async function fetchFollowingRedirects(options: FollowRedirectsOptions): Promise<{ response: Response; finalUrl: string }> {
  const { fetchImpl, start, signal, headers, maxRedirects = 10, validate, trustedOrigin, label, originName } = options;
  let current = start;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    await validate?.(current);
    const response = await fetchImpl(current, { redirect: "manual", signal, headers });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current.href };
    const location = response.headers.get("location");
    if (!location) throw new Error(label ? `${label} redirect ${response.status} has no Location header` : `Redirect ${response.status} has no Location header`);
    if (redirects === maxRedirects) throw new Error(label ? `${label} redirected too many times` : "Too many redirects");
    const next = new URL(location, current);
    if ((next.protocol !== "http:" && next.protocol !== "https:") || (trustedOrigin !== undefined && next.origin !== trustedOrigin)) {
      throw new Error(label ? `${label} redirect leaves ${originName ?? "the configured origin"}` : "Redirect leaves the configured origin");
    }
    current = next;
  }
  throw new Error(label ? `${label} redirected too many times` : "Too many redirects");
}
