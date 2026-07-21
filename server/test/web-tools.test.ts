import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import type { CoreClientLike } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderRegistry, type Provider, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { assertSafeWebUrl, createSearchProvider, createWebFetchProvider, htmlToText, webFetch, type SearchProvider, type WebFetchProvider } from "../src/web-tools.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const textResponse = (body: string, init: ResponseInit = {}) => new Response(body, {
  status: 200,
  headers: { "content-type": "text/plain", ...(init.headers as Record<string, string> | undefined) },
  ...init,
});

describe("webFetch", () => {
  it.each([
    "http://localhost/", "http://sub.localhost/", "http://127.1.2.3/", "http://10.0.0.1/",
    "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/",
    "http://169.254.169.254/", "http://[::1]/", "http://[fc00::1]/", "http://[fd12::1]/",
    "http://[fe80::1]/", "http://[febf::ffff]/",
    "ftp://example.com/",
  ])("rejects unsafe URL %s", (url) => expect(() => assertSafeWebUrl(url)).toThrow());

  it.each(["https://example.com/", "http://172.15.0.1/", "http://172.32.0.1/"])("allows public URL %s", (url) => {
    expect(assertSafeWebUrl(url).href).toBe(url);
  });

  it("validates every redirect and does not request the blocked target", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } });
    }) as typeof fetch;
    await expect(webFetch("https://example.com/start", { fetchImpl })).rejects.toThrow(/private network/i);
    expect(seen).toEqual(["https://example.com/start"]);
  });

  it("follows relative redirects and converts HTML to text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/start")
      ? new Response(null, { status: 302, headers: { location: "/final" } })
      : textResponse("<style>hide</style><h1>Hello &amp; world</h1><script>bad()</script>", { headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    const result = await webFetch("https://example.com/start", { fetchImpl });
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.text).toBe("Hello & world");
  });

  it("rejects binary and oversized responses", async () => {
    await expect(webFetch("https://example.com/image", { fetchImpl: (async () => new Response("x", { headers: { "content-type": "image/png" } })) as typeof fetch })).rejects.toThrow(/content type/i);
    await expect(webFetch("https://example.com/large", { maxBytes: 3, fetchImpl: (async () => textResponse("four")) as typeof fetch })).rejects.toThrow(/byte limit/i);
  });
});

describe("search providers", () => {
  it("honestly degrades and maps Brave/Tavily results", async () => {
    expect(createSearchProvider(undefined)).toBeUndefined();
    expect(createSearchProvider({ provider: "brave" })).toBeUndefined();
    expect(createSearchProvider({ provider: "tavily" })).toBeUndefined();
    expect(createSearchProvider({ provider: "brave", apiKey: "   " })).toBeUndefined();
    expect(createSearchProvider({ provider: "custom", baseURL: "not a URL" })).toBeUndefined();
    expect(createSearchProvider({ provider: "custom", baseURL: "ftp://search.test" })).toBeUndefined();
    const fetchImpl = vi.fn(async () => Response.json({ web: { results: [{ title: "One", url: "https://one.test", description: "First" }] } })) as typeof fetch;
    const provider = createSearchProvider({ provider: "brave", apiKey: "secret" }, fetchImpl)!;
    expect(await provider.search("query", 5)).toEqual([{ title: "One", url: "https://one.test", snippet: "First" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const tavilyFetch = vi.fn(async () => Response.json({ results: [{ title: "Two", url: "https://two.test", content: "Second" }] })) as typeof fetch;
    const tavily = createSearchProvider({ provider: "tavily", apiKey: "tvly-secret" }, tavilyFetch)!;
    await expect(tavily.search("query", 3)).resolves.toEqual([{ title: "Two", url: "https://two.test", snippet: "Second" }]);
    const [endpoint, request] = tavilyFetch.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.tavily.com/search");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({ query: "query", max_results: 3 });
  });

  it("cleans common HTML constructs", () => {
    expect(htmlToText("<p>A&nbsp;B</p><div>&#x43; &#68;</div>")).toBe("A B\nC D");
  });
});

describe("web fetch providers", () => {
  it("requires an explicit provider and supports Jina or a URL-template reader", async () => {
    expect(createWebFetchProvider(undefined)).toBeUndefined();
    expect(createWebFetchProvider({ provider: "custom" })).toBeUndefined();
    expect(createWebFetchProvider({ provider: "custom", baseURL: "https://reader.test/fetch" })).toBeUndefined();
    const fetchImpl = vi.fn(async () => textResponse("reader result")) as typeof fetch;
    const jina = createWebFetchProvider({ provider: "jina", apiKey: "key" }, fetchImpl)!;
    await expect(jina.fetchUrl("https://example.com/article")).resolves.toMatchObject({ url: "https://example.com/article", text: "reader result" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://r.jina.ai/https://example.com/article");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer key" }) });

    const customFetch = vi.fn(async () => textResponse("custom result")) as typeof fetch;
    const custom = createWebFetchProvider({ provider: "custom", baseURL: "https://reader.test/fetch?url={url}" }, customFetch)!;
    await custom.fetchUrl("https://example.com/a?b=1");
    expect(String(customFetch.mock.calls[0]?.[0])).toBe("https://reader.test/fetch?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1");
  });
});

describe("AgentRunner web tools", () => {
  async function exposedTools(search?: SearchProvider, webFetchProvider?: WebFetchProvider): Promise<string[]> {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-web-tools-")); roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = { name: "fake", async *streamChat(request) { requests.push(request); yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, search, undefined, undefined, undefined, undefined, webFetchProvider);
    await runner.run(session.id, "check tools");
    return requests[0]?.tools.map((tool) => tool.name) ?? [];
  }

  it("only injects web tools whose service is configured", async () => {
    const search: SearchProvider = { name: "fake", async search() { return []; } };
    const webFetchProvider: WebFetchProvider = { name: "fake-reader", async fetchUrl() { return { url: "https://example.com", finalUrl: "https://example.com", contentType: "text/plain", text: "ok" }; } };
    const [withoutServices, withSearch, withFetch, withBoth] = await Promise.all([
      exposedTools(), exposedTools(search), exposedTools(undefined, webFetchProvider), exposedTools(search, webFetchProvider),
    ]);
    expect(withoutServices).not.toContain("web_fetch");
    expect(withoutServices).not.toContain("web_search");
    expect(withSearch).toContain("web_search");
    expect(withSearch).not.toContain("web_fetch");
    expect(withFetch).toContain("web_fetch");
    expect(withFetch).not.toContain("web_search");
    expect(withBoth).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
  }, 15_000);
});
