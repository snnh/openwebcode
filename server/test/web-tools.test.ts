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
import { assertSafeWebUrl, createProfileSearchProvider, createProfileWebFetchProvider, htmlToText, webFetch, type SearchProvider, type WebFetchProvider } from "../src/web-tools.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const textResponse = (body: string, init: ResponseInit = {}) => new Response(body, {
  status: 200,
  headers: { "content-type": "text/plain", ...(init.headers as Record<string, string> | undefined) },
  ...init,
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("webFetch", () => {
  it.each([
    "http://localhost/", "http://sub.localhost/", "http://127.1.2.3/", "http://10.0.0.1/",
    "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/",
    "http://0.0.0.0/", "http://100.64.0.1/", "http://169.254.169.254/", "http://192.0.2.1/",
    "http://198.18.0.1/", "http://198.51.100.1/", "http://203.0.113.1/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/",
    "http://[fc00::1]/", "http://[fd12::1]/", "http://[fe80::1]/", "http://[febf::ffff]/",
    "http://[ff02::1]/", "http://[100::1]/", "http://[2001:db8::1]/",
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
    await expect(webFetch("https://example.com/start", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/private network/i);
    expect(seen).toEqual(["https://example.com/start"]);
  });

  it("follows relative redirects and converts HTML to text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/start")
      ? new Response(null, { status: 302, headers: { location: "/final" } })
      : textResponse("<style>hide</style><h1>Hello &amp; world</h1><script>bad()</script>", { headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    const result = await webFetch("https://example.com/start", { fetchImpl, lookupImpl: publicLookup });
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.text).toBe("Hello & world");
  });

  it("rejects binary and oversized responses", async () => {
    await expect(webFetch("https://example.com/image", { lookupImpl: publicLookup, fetchImpl: (async () => new Response("x", { headers: { "content-type": "image/png" } })) as typeof fetch })).rejects.toThrow(/content type/i);
    await expect(webFetch("https://example.com/large", { maxBytes: 3, lookupImpl: publicLookup, fetchImpl: (async () => textResponse("four")) as typeof fetch })).rejects.toThrow(/byte limit/i);
  });

  it("rejects domains that resolve to private addresses (DNS rebinding)", async () => {
    const fetchImpl = vi.fn(async () => textResponse("ok")) as typeof fetch;
    const internalLookup = async () => [{ address: "192.168.1.10", family: 4 }];
    await expect(webFetch("https://rebinding.example/", { fetchImpl, lookupImpl: internalLookup })).rejects.toThrow(/private network/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    // 公网 + 内网混合解析：任一内网地址即拒绝
    const mixedLookup = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }];
    await expect(webFetch("https://rebinding.example/", { fetchImpl, lookupImpl: mixedLookup })).rejects.toThrow(/private network/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("search providers", () => {
  it("honestly degrades and maps Brave/Tavily results", async () => {
    expect(createProfileSearchProvider(undefined)).toBeUndefined();
    expect(createProfileSearchProvider({ id: "brave", provider: "brave", capabilities: ["search"] })).toBeUndefined();
    expect(createProfileSearchProvider({ id: "tavily", provider: "tavily", capabilities: ["search"] })).toBeUndefined();
    expect(createProfileSearchProvider({ id: "brave", provider: "brave", capabilities: ["search"], apiKey: "   " })).toBeUndefined();
    expect(createProfileSearchProvider({ id: "custom", provider: "custom", capabilities: ["search"], searchBaseURL: "not a URL" })).toBeUndefined();
    expect(createProfileSearchProvider({ id: "custom", provider: "custom", capabilities: ["search"], searchBaseURL: "ftp://search.test" })).toBeUndefined();
    const fetchImpl = vi.fn(async () => Response.json({ web: { results: [{ title: "One", url: "https://one.test", description: "First" }] } })) as typeof fetch;
    const provider = createProfileSearchProvider({ id: "brave-main", provider: "brave", capabilities: ["search"], apiKey: "secret" }, fetchImpl)!;
    expect(await provider.search("query", 5)).toEqual([{ title: "One", url: "https://one.test", snippet: "First" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const tavilyFetch = vi.fn(async () => Response.json({ results: [{ title: "Two", url: "https://two.test", content: "Second" }] })) as typeof fetch;
    const tavily = createProfileSearchProvider({ id: "tavily-main", provider: "tavily", capabilities: ["search"], apiKey: "tvly-secret" }, tavilyFetch)!;
    await expect(tavily.search("query", 3)).resolves.toEqual([{ title: "Two", url: "https://two.test", snippet: "Second" }]);
    const [endpoint, request] = tavilyFetch.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.tavily.com/search");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({ query: "query", max_results: 3 });
  });


  it("re-validates every search redirect against the configured origin", async () => {
    const crossOrigin = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })) as typeof fetch;
    const provider = createProfileSearchProvider({ id: "custom", provider: "custom", capabilities: ["search"], searchBaseURL: "https://search.example/api" }, crossOrigin)!;
    await expect(provider.search("query", 5)).rejects.toThrow(/origin/i);
    expect(crossOrigin).toHaveBeenCalledOnce();
    expect(crossOrigin.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

    const seen: string[] = [];
    const sameOrigin = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return String(input).endsWith("/api?q=query&count=5")
        ? new Response(null, { status: 302, headers: { location: "/api/v2?q=query&count=5" } })
        : Response.json({ results: [{ title: "One", url: "https://one.test", description: "First" }] });
    }) as typeof fetch;
    const follower = createProfileSearchProvider({ id: "custom", provider: "custom", capabilities: ["search"], searchBaseURL: "https://search.example/api" }, sameOrigin)!;
    await expect(follower.search("query", 5)).resolves.toEqual([{ title: "One", url: "https://one.test", snippet: "First" }]);
    expect(seen).toEqual(["https://search.example/api?q=query&count=5", "https://search.example/api/v2?q=query&count=5"]);
  });

  it("cleans common HTML constructs", () => {
    expect(htmlToText("<p>A&nbsp;B</p><div>&#x43; &#68;</div>")).toBe("A B\nC D");
  });

  it("propagates caller aborts and bounds Tavily JSON responses", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const waitingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true });
      });
    }) as typeof fetch;
    const abortable = createProfileSearchProvider({ id: "tavily", provider: "tavily", capabilities: ["search"], apiKey: "tvly-secret" }, waitingFetch)!;
    const controller = new AbortController();
    const pending = abortable.search("query", 1, { signal: controller.signal });
    controller.abort(new Error("cancelled by user"));
    await expect(pending).rejects.toThrow("cancelled by user");
    expect(receivedSignal?.aborted).toBe(true);

    const oversizedFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        stream.close();
      },
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const bounded = createProfileSearchProvider({ id: "tavily", provider: "tavily", capabilities: ["search"], apiKey: "tvly-secret" }, oversizedFetch)!;
    await expect(bounded.search("query", 1)).rejects.toThrow(/byte limit/i);
  });
});

describe("web fetch providers", () => {
  it("requires an explicit provider and supports Jina, Tavily, or a URL-template reader", async () => {
    expect(createProfileWebFetchProvider(undefined)).toBeUndefined();
    expect(createProfileWebFetchProvider({ id: "custom", provider: "custom", capabilities: ["fetch"] })).toBeUndefined();
    expect(createProfileWebFetchProvider({ id: "custom", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/fetch" })).toBeUndefined();
    const fetchImpl = vi.fn(async () => textResponse("reader result")) as typeof fetch;
    const jina = createProfileWebFetchProvider({ id: "jina", provider: "jina", capabilities: ["search", "fetch"], apiKey: "key" }, fetchImpl)!;
    await expect(jina.fetchUrl("https://example.com/article")).resolves.toMatchObject({ url: "https://example.com/article", text: "reader result" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://r.jina.ai/https://example.com/article");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer key" }) });

    const tavilyFetch = vi.fn(async () => Response.json({
      results: [{ url: "https://example.com/article", raw_content: "# Tavily result" }],
      failed_results: [],
    })) as typeof fetch;
    const tavily = createProfileWebFetchProvider({ id: "tavily", provider: "tavily", capabilities: ["search", "fetch"], apiKey: "tvly-secret" }, tavilyFetch)!;
    await expect(tavily.fetchUrl("https://example.com/article")).resolves.toMatchObject({
      url: "https://example.com/article",
      finalUrl: "https://example.com/article",
      contentType: "text/markdown; charset=utf-8",
      text: "# Tavily result",
    });
    expect(tavilyFetch.mock.calls[0]?.[0]).toBe("https://api.tavily.com/extract");
    expect(tavilyFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tvly-secret", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(tavilyFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      urls: "https://example.com/article",
      extract_depth: "basic",
      format: "markdown",
    });

    const customFetch = vi.fn(async () => textResponse("custom result")) as typeof fetch;
    const custom = createProfileWebFetchProvider({ id: "custom", provider: "custom", capabilities: ["fetch"], fetchBaseURL: "https://reader.test/fetch?url={url}" }, customFetch)!;
    await custom.fetchUrl("https://example.com/a?b=1");
    expect(String(customFetch.mock.calls[0]?.[0])).toBe("https://reader.test/fetch?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1");
  });

  it("does not follow a reader redirect to an untrusted origin", async () => {
    const crossOriginFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    })) as typeof fetch;
    const provider = createProfileWebFetchProvider({ id: "jina", provider: "jina", capabilities: ["search", "fetch"], apiKey: "key" }, crossOriginFetch)!;
    await expect(provider.fetchUrl("https://example.com/article")).rejects.toThrow(/leaves the configured reader origin/i);
    expect(crossOriginFetch).toHaveBeenCalledOnce();
    expect(crossOriginFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });

    const sameOriginFetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/final")
      ? textResponse("followed safely")
      : new Response(null, { status: 302, headers: { location: "/final" } })) as typeof fetch;
    const sameOrigin = createProfileWebFetchProvider({ id: "jina", provider: "jina", capabilities: ["search", "fetch"], apiKey: "key" }, sameOriginFetch)!;
    await expect(sameOrigin.fetchUrl("https://example.com/article")).resolves.toMatchObject({ text: "followed safely" });
    expect(sameOriginFetch).toHaveBeenCalledTimes(2);
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
