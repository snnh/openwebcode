import { isIP } from "node:net";
import type { ServerConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  contentType: string;
  text: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

function blockedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function blockedIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "::1") return true;
  const first = normalized.split(":", 1)[0] ?? "";
  if (!first) return false;
  const firstNum = Number.parseInt(first, 16);
  if (Number.isNaN(firstNum)) return false;
  // fc00::/7 唯一本地（fc00–fdff），fe80::/10 链路本地（fe80–febf）——均为内网，防 SSRF
  return (firstNum & 0xfe00) === 0xfc00 || (firstNum & 0xffc0) === 0xfe80;
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

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
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
  return new TextDecoder().decode(body);
}

function supportedContentType(value: string): boolean {
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml");
}

export async function webFetch(
  value: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<WebFetchResult> {
  const requested = assertSafeWebUrl(value);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let current = requested;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    current = assertSafeWebUrl(current.href);
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} has no Location header`);
      if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects");
      current = assertSafeWebUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const contentType = response.headers.get("content-type") ?? "";
    if (!supportedContentType(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    const raw = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    return {
      url: requested.href,
      finalUrl: current.href,
      contentType,
      text: contentType.toLowerCase().startsWith("text/html") ? htmlToText(raw) : raw,
    };
  }
  throw new Error("Too many redirects");
}

function normalizeResults(value: unknown, limit: number): SearchResult[] {
  const root = value as { web?: { results?: unknown[] }; results?: unknown[] };
  const items = root?.web?.results ?? root?.results ?? [];
  if (!Array.isArray(items)) return [];
  return items.slice(0, limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const snippet = typeof entry.description === "string" ? entry.description : typeof entry.snippet === "string" ? entry.snippet : "";
    return title && url ? [{ title, url, snippet }] : [];
  });
}

class HttpSearchProvider implements SearchProvider {
  constructor(
    readonly name: string,
    private readonly baseURL: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = new URL(this.baseURL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const headers = this.apiKey
      ? (this.name === "brave" ? { "X-Subscription-Token": this.apiKey } : { Authorization: `Bearer ${this.apiKey}` })
      : undefined;
    const response = await this.fetchImpl(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
    return normalizeResults(await response.json(), limit);
  }
}

export function createSearchProvider(config: ServerConfig["search"], fetchImpl: typeof fetch = globalThis.fetch): SearchProvider | undefined {
  if (!config) return undefined;
  if (config.provider === "brave") {
    if (!config.apiKey) return undefined;
    return new HttpSearchProvider("brave", "https://api.search.brave.com/res/v1/web/search", config.apiKey, fetchImpl);
  }
  if (!config.baseURL) return undefined;
  return new HttpSearchProvider("custom", config.baseURL, config.apiKey, fetchImpl);
}
