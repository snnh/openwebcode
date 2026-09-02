/**
 * read_media 的 URL 抓取通道：与 webFetch 同一安全纪律（assertSafeWebUrl 私网/回环块表 +
 * DNS 解析复查 + fetchFollowingRedirects 逐跳复验 + withTimeout），差异在载荷——
 * content-type 白名单（image/*、video/*）先行，魔数嗅探最终确认（魔数权威），
 * 字节经 readResponseLimited 上限读取。非媒体内容明确报错并指引改用 web_fetch。
 */
import { fetchFollowingRedirects, readResponseLimited, withTimeout } from "./http-utils.js";
import { sniffMedia, type MediaKind } from "./media-sniff.js";
import { getUserAgent } from "./user-agent.js";
import { assertPublicHostname, assertSafeWebUrl, type LookupAll } from "./web-tools.js";

const DEFAULT_TIMEOUT_MS = 30_000;
/** 默认字节上限与 core fs.readBase64 一致（20 MiB）：视频上限即读取上限。 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface FetchedMedia {
  kind: MediaKind;
  mediaType: string;
  bytes: Uint8Array;
  /** 重定向链终点（诊断与扩展名兜底用）。 */
  finalUrl: string;
}

/** content-type 白名单（第一道口子；最终以魔数为准）。 */
function mediaContentType(value: string): boolean {
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("image/") || type.startsWith("video/");
}

export async function fetchMedia(
  value: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; lookupImpl?: LookupAll; signal?: AbortSignal } = {},
): Promise<FetchedMedia> {
  const requested = assertSafeWebUrl(value);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookup = options.lookupImpl;
  const signal = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 每跳复验 SSRF 网关（含起始）：与 webFetch 同口径
  const { response, finalUrl } = await fetchFollowingRedirects({
    fetchImpl,
    start: requested,
    signal,
    headers: { "User-Agent": getUserAgent(), Accept: "image/*,video/*" },
    maxRedirects: MAX_REDIRECTS,
    validate: async (url) => {
      assertSafeWebUrl(url.href);
      await assertPublicHostname(url, lookup);
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const contentType = response.headers.get("content-type") ?? "";
  if (!mediaContentType(contentType)) {
    throw new Error(`URL did not return image or video content (content-type: ${contentType || "unknown"}). Use web_fetch for web pages or text resources.`);
  }
  const bytes = await readResponseLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  // 魔数确认（content-type 可伪造/错配，魔数权威）；扩展名仅作裸流视频的兜底
  let pathname: string | undefined;
  try {
    pathname = new URL(finalUrl).pathname;
  } catch { /* finalUrl 非合法 URL 时无扩展名兜底 */ }
  const sniffed = sniffMedia(bytes, pathname);
  if (!sniffed) {
    throw new Error("URL content is not a recognized image or video format (magic bytes mismatch). Use web_fetch for other content.");
  }
  return { kind: sniffed.kind, mediaType: sniffed.mediaType, bytes, finalUrl };
}
