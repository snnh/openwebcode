import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebProviderProfile } from "./provider-profiles.js";
import { fetchFollowingRedirects, readJsonLimited, readTextLimited, withTimeout } from "./http-utils.js";
import { getUserAgent } from "./user-agent.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 10;

interface WebFetchResult {
  url: string;
  finalUrl: string;
  contentType: string;
  text: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  name: string;
  /** The optional signal keeps older two-argument callers compatible. */
  search(query: string, limit: number, options?: { signal?: AbortSignal }): Promise<SearchResult[]>;
}

/** A configured reader service used by web_fetch. It is intentionally absent by default. */
export interface WebFetchProvider {
  name: string;
  fetchUrl(url: string, options?: { signal?: AbortSignal }): Promise<WebFetchResult>;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  return octets as [number, number, number, number];
}

/** Block private, loopback, link-local, benchmark, documentation, multicast and other non-public IPv4 ranges. */
function blockedIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname);
  if (!octets) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function parseIpv6Side(value: string): number[] | undefined {
  if (!value) return [];
  const words: number[] = [];
  for (const part of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

/** Parse enough of an IPv6 literal to identify IPv4-mapped and special-use ranges. */
function parseIpv6(hostname: string): number[] | undefined {
  let value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator === -1) return undefined;
    const tail = parseIpv4(value.slice(separator + 1));
    if (!tail) return undefined;
    const [a, b, c, d] = tail;
    value = `${value.slice(0, separator)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const head = parseIpv6Side(halves[0]!);
  const tail = parseIpv6Side(halves[1] ?? "");
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...Array<number>(missing).fill(0), ...tail];
}

function blockedIpv6(hostname: string): boolean {
  const words = parseIpv6(hostname);
  if (!words) return false;
  const first = words[0]!;
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  const firstSixZero = firstFiveZero && words[5] === 0;
  // IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d) literals
  // must inherit the IPv4 deny list; otherwise ::ffff:127.0.0.1 bypasses it.
  if (firstSixZero || (firstFiveZero && words[5] === 0xffff)) {
    const ipv4 = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
    if (blockedIpv4(ipv4)) return true;
  }
  // :: is unspecified, ::1 is loopback.
  if (words.every((word) => word === 0) || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) return true;
  // fc00::/7 unique local; fe80::/10 link-local; fec0::/10 deprecated site-local;
  // ff00::/8 multicast. Also reject discard, benchmark and documentation ranges.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 ||
    (first === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) ||
    (first === 0x2001 && (words[1] === 0x0002 || words[1] === 0x0db8));
}

export function assertSafeWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Local network URLs are not allowed");
  const kind = isIP(hostname);
  if ((kind === 4 && blockedIpv4(hostname)) || (kind === 6 && blockedIpv6(hostname))) {
    throw new Error("Local or private network URLs are not allowed");
  }
  return url;
}

/** dns.lookup({all:true}) 的可注入形态：测试用 stub 避免真实 DNS。 */
export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true });

/**
 * 对非 IP 字面量的域名做 DNS 解析，逐地址套用与 assertSafeWebUrl 相同的私网/回环块表，
 * 挡住「域名解析结果就是内网地址」的 SSRF（含 DNS 重绑定到内网的情形）。
 * TOCTOU 残余：解析完成到 TCP 连接建立之间记录仍可能再变，彻底闭环需要在连接层
 * 校验对端 IP；此处先兜住解析期即可判定的内网结果。
 */
export async function assertPublicHostname(url: URL, lookup: LookupAll = defaultLookup): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) return; // IP 字面量已由 assertSafeWebUrl 筛查
  const addresses = await lookup(hostname);
  for (const { address, family } of addresses) {
    if ((family === 4 && blockedIpv4(address)) || (family === 6 && blockedIpv6(address))) {
      throw new Error("Local or private network URLs are not allowed");
    }
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return String.fromCodePoint(codePoint); } catch { return match; }
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function supportedContentType(value: string): boolean {
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml");
}

export async function webFetch(
  value: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; lookupImpl?: LookupAll; signal?: AbortSignal } = {},
): Promise<WebFetchResult> {
  const requested = assertSafeWebUrl(value);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookup = options.lookupImpl ?? defaultLookup;
  const signal = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 每跳复验 SSRF 网关（含起始）：域名逐地址查私网表，重定向目标同样受检
  const { response, finalUrl } = await fetchFollowingRedirects({
    fetchImpl,
    start: requested,
    signal,
    headers: { "User-Agent": getUserAgent() },
    maxRedirects: MAX_REDIRECTS,
    validate: async (url) => {
      assertSafeWebUrl(url.href);
      await assertPublicHostname(url, lookup);
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const contentType = response.headers.get("content-type") ?? "";
  if (!supportedContentType(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
  const raw = await readTextLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    url: requested.href,
    finalUrl,
    contentType,
    text: contentType.toLowerCase().startsWith("text/html") ? htmlToText(raw) : raw,
  };
}

/**
 * Reader services fetch the public target on the user's behalf.  We still
 * validate the target before passing it onward, but do not silently fall back
 * to a direct server-side request when no reader was configured.
 */
class HttpReaderProvider implements WebFetchProvider {
  constructor(
    readonly name: string,
    private readonly endpointFor: (requested: URL) => URL,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async fetchUrl(value: string, options: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const requested = assertSafeWebUrl(value);
    const signal = withTimeout(options.signal, DEFAULT_TIMEOUT_MS);
    const current = this.endpointFor(requested);
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error(`${this.name} endpoint is not http/https`);
    // Do not let a reader-provided redirect leave the configured reader origin:
    // otherwise a compromised reader could 302 an authorized request elsewhere.
    const { response } = await fetchFollowingRedirects({
      fetchImpl: this.fetchImpl,
      start: current,
      signal,
      headers: {
        Accept: "text/plain, text/markdown, text/html;q=0.9, application/json;q=0.8",
        "User-Agent": getUserAgent(),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      maxRedirects: MAX_REDIRECTS,
      trustedOrigin: current.origin,
      label: this.name,
      originName: "the configured reader origin",
    });
    if (!response.ok) throw new Error(`${this.name} returned HTTP ${response.status} ${response.statusText}`.trim());
    const contentType = response.headers.get("content-type") ?? "text/plain";
    if (!supportedContentType(contentType)) throw new Error(`${this.name} returned unsupported content type: ${contentType || "unknown"}`);
    const raw = await readTextLimited(response, DEFAULT_MAX_BYTES);
    return {
      url: requested.href,
      // A reader endpoint may follow redirects internally but cannot reliably
      // report the target's terminal URL, so never leak its own service URL.
      finalUrl: requested.href,
      contentType,
      text: contentType.toLowerCase().startsWith("text/html") ? htmlToText(raw) : raw,
    };
  }
}

function customReaderEndpoint(template: string, requested: URL): URL {
  return new URL(template.replaceAll("{url}", encodeURIComponent(requested.href)));
}

function normalizeResults(value: unknown, limit: number): SearchResult[] {
  const root = value as {
    web?: { results?: unknown[] };
    results?: unknown[];
    data?: unknown[] | { webPages?: { value?: unknown[] } };
  };
  const dataField = root?.data;
  const items = root?.web?.results
    ?? root?.results
    ?? (Array.isArray(dataField) ? dataField : (dataField as { webPages?: { value?: unknown[] } })?.webPages?.value)
    ?? [];
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title
      : typeof entry.name === "string" ? entry.name
        : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const snippet = typeof entry.description === "string" ? entry.description
      : typeof entry.snippet === "string" ? entry.snippet
        : typeof entry.content === "string" ? entry.content
          : "";
    return title && url ? [{ title, url, snippet }] : [];
  });
}

class HttpSearchProvider implements SearchProvider {
  constructor(
    readonly name: string,
    private readonly baseURL: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly authKind: "brave" | "bearer" = "bearer",
  ) {}

  async search(query: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const url = new URL(this.baseURL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": getUserAgent() };
    if (this.apiKey) {
      if (this.authKind === "brave") headers["X-Subscription-Token"] = this.apiKey;
      else headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const signal = withTimeout(options.signal, DEFAULT_TIMEOUT_MS);
    // 与 reader 路径同一纪律：redirect 手动处理，逐跳复验不离开配置的 search origin，
    // 否则被控/被劫持的 search 端点可用 302 把带凭据的请求引向任意主机（SSRF）。
    const { response } = await fetchFollowingRedirects({
      fetchImpl: this.fetchImpl,
      start: url,
      signal,
      headers,
      maxRedirects: MAX_REDIRECTS,
      trustedOrigin: url.origin,
      label: "Search provider",
    });
    if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
    return normalizeResults(await readJsonLimited(response, DEFAULT_MAX_BYTES), limit);
  }
}

class TavilySearchProvider implements SearchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async search(query: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const response = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
    return normalizeResults(await readJsonLimited(response, DEFAULT_MAX_BYTES), limit);
  }
}

class TavilyExtractProvider implements WebFetchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async fetchUrl(value: string, options: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const requested = assertSafeWebUrl(value);
    const response = await this.fetchImpl("https://api.tavily.com/extract", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({
        urls: requested.href,
        extract_depth: "basic",
        include_images: false,
        format: "markdown",
      }),
      signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Tavily Extract returned HTTP ${response.status}`);
    const body = await readJsonLimited(response, DEFAULT_MAX_BYTES) as {
      results?: Array<{ url?: unknown; raw_content?: unknown }>;
      failed_results?: Array<{ url?: unknown; error?: unknown }>;
    };
    const result = body.results?.[0];
    if (!result || typeof result.raw_content !== "string" || result.raw_content.trim() === "") {
      const failure = body.failed_results?.[0]?.error;
      throw new Error(`Tavily Extract returned no content${typeof failure === "string" && failure ? `: ${failure}` : ""}`);
    }
    return {
      url: requested.href,
      finalUrl: requested.href,
      contentType: "text/markdown; charset=utf-8",
      text: result.raw_content,
    };
  }
}

class BingSearchProvider implements SearchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async search(query: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    url.searchParams.set("textDecorations", "false");
    const signal = withTimeout(options.signal, DEFAULT_TIMEOUT_MS);
    const { response } = await fetchFollowingRedirects({
      fetchImpl: this.fetchImpl,
      start: url,
      signal,
      headers: { "Ocp-Apim-Subscription-Key": this.apiKey, Accept: "application/json", "User-Agent": getUserAgent() },
      maxRedirects: MAX_REDIRECTS,
      trustedOrigin: url.origin,
      label: "Bing",
    });
    if (!response.ok) throw new Error(`Bing returned HTTP ${response.status}`);
    const body = await readJsonLimited(response, DEFAULT_MAX_BYTES) as { webPages?: { value?: unknown[] } };
    const items = body?.webPages?.value ?? [];
    return (Array.isArray(items) ? items : []).slice(0, limit).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const title = typeof entry.name === "string" ? entry.name : "";
      const url2 = typeof entry.url === "string" ? entry.url : "";
      const snippet = typeof entry.snippet === "string" ? entry.snippet : "";
      return title && url2 ? [{ title, url: url2, snippet }] : [];
    });
  }
}

class ExaSearchProvider implements SearchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async search(query: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const response = await this.fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({ query, numResults: limit, type: "neural" }),
      signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Exa returned HTTP ${response.status}`);
    return normalizeResults(await readJsonLimited(response, DEFAULT_MAX_BYTES), limit);
  }
}

class LinkUpSearchProvider implements SearchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch, private readonly depth: string) {}

  async search(query: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const response = await this.fetchImpl("https://api.linkup.so/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({ q: query, depth: this.depth, outputType: "searchResults", maxResults: limit }),
      signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`LinkUp returned HTTP ${response.status}`);
    return normalizeResults(await readJsonLimited(response, DEFAULT_MAX_BYTES), limit);
  }
}

class FirecrawlFetchProvider implements WebFetchProvider {
  constructor(readonly name: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch) {}

  async fetchUrl(value: string, options: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const requested = assertSafeWebUrl(value);
    const response = await this.fetchImpl("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({ url: requested.href, formats: ["markdown"] }),
      signal: withTimeout(options.signal, DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Firecrawl returned HTTP ${response.status}`);
    const body = await readJsonLimited(response, DEFAULT_MAX_BYTES) as { data?: { markdown?: string; content?: string } };
    const text = body?.data?.markdown ?? body?.data?.content ?? "";
    if (!text) throw new Error("Firecrawl returned no content");
    return {
      url: requested.href,
      finalUrl: requested.href,
      contentType: "text/markdown; charset=utf-8",
      text,
    };
  }
}

/** Build a search implementation from a named profile. The profile's declared
 * capability is the public contract; provider kind only selects wire format. */
export function createProfileSearchProvider(
  profile: WebProviderProfile | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): SearchProvider | undefined {
  if (!profile?.capabilities.includes("search")) return undefined;
  const apiKey = profile.apiKey?.trim() || undefined;
  if (profile.provider === "brave") {
    return apiKey ? new HttpSearchProvider(profile.id, "https://api.search.brave.com/res/v1/web/search", apiKey, fetchImpl, "brave") : undefined;
  }
  if (profile.provider === "tavily") return apiKey ? new TavilySearchProvider(profile.id, apiKey, fetchImpl) : undefined;
  if (profile.provider === "bing") return apiKey ? new BingSearchProvider(profile.id, apiKey, fetchImpl) : undefined;
  if (profile.provider === "exa") return apiKey ? new ExaSearchProvider(profile.id, apiKey, fetchImpl) : undefined;
  if (profile.provider === "linkup") return apiKey ? new LinkUpSearchProvider(profile.id, apiKey, fetchImpl, profile.searchDepth ?? "standard") : undefined;
  if (profile.provider === "bocha") {
    return apiKey ? new HttpSearchProvider(profile.id, "https://api.bochaai.com/v1/web-search", apiKey, fetchImpl) : undefined;
  }
  if (profile.provider === "searxng") {
    const baseURL = profile.searchBaseURL?.trim();
    if (!baseURL) return undefined;
    try {
      const parsed = new URL(baseURL);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? new HttpSearchProvider(profile.id, `${parsed.href.replace(/\/$/, "")}/search`, apiKey, fetchImpl)
        : undefined;
    } catch { return undefined; }
  }
  if (profile.provider === "jina") {
    return new HttpSearchProvider(profile.id, profile.searchBaseURL ?? "https://s.jina.ai/", apiKey, fetchImpl);
  }
  const baseURL = profile.searchBaseURL?.trim();
  if (!baseURL) return undefined;
  try {
    const parsed = new URL(baseURL);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? new HttpSearchProvider(profile.id, parsed.href, apiKey, fetchImpl)
      : undefined;
  } catch { return undefined; }
}

export function createProfileWebFetchProvider(
  profile: WebProviderProfile | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): WebFetchProvider | undefined {
  if (!profile?.capabilities.includes("fetch")) return undefined;
  const apiKey = profile.apiKey?.trim() || undefined;
  if (profile.provider === "jina") {
    return new HttpReaderProvider(profile.id, (requested) => new URL(`https://r.jina.ai/${requested.href}`), apiKey, fetchImpl);
  }
  if (profile.provider === "tavily") {
    return apiKey ? new TavilyExtractProvider(profile.id, apiKey, fetchImpl) : undefined;
  }
  if (profile.provider === "firecrawl") {
    return apiKey ? new FirecrawlFetchProvider(profile.id, apiKey, fetchImpl) : undefined;
  }
  if (profile.provider !== "custom") return undefined;
  const template = profile.fetchBaseURL?.trim();
  if (!template?.includes("{url}")) return undefined;
  try {
    const probe = customReaderEndpoint(template, new URL("https://example.com/"));
    return probe.protocol === "http:" || probe.protocol === "https:"
      ? new HttpReaderProvider(profile.id, (requested) => customReaderEndpoint(template, requested), apiKey, fetchImpl)
      : undefined;
  } catch { return undefined; }
}
