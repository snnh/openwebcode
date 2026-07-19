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
import { assertSafeWebUrl, createSearchProvider, htmlToText, webFetch, type SearchProvider } from "../src/web-tools.js";

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
  it("honestly degrades and maps Brave results", async () => {
    expect(createSearchProvider(undefined)).toBeUndefined();
    expect(createSearchProvider({ provider: "brave" })).toBeUndefined();
    const fetchImpl = vi.fn(async () => Response.json({ web: { results: [{ title: "One", url: "https://one.test", description: "First" }] } })) as typeof fetch;
    const provider = createSearchProvider({ provider: "brave", apiKey: "secret" }, fetchImpl)!;
    expect(await provider.search("query", 5)).toEqual([{ title: "One", url: "https://one.test", snippet: "First" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cleans common HTML constructs", () => {
    expect(htmlToText("<p>A&nbsp;B</p><div>&#x43; &#68;</div>")).toBe("A B\nC D");
  });
});

describe("AgentRunner web tools", () => {
  async function exposedTools(search?: SearchProvider): Promise<string[]> {
    const root = await mkdtemp(path.join(os.tmpdir(), "owc-web-tools-")); roots.push(root);
    const sessions = new SessionStore(path.join(root, "sessions")); await sessions.initialize();
    const session = await sessions.create({ cwd: root, provider: "fake", model: "model" });
    await sessions.updatePermissions(session.id, "yolo", []);
    const pricing = new PricingCatalog(path.join(root, "pricing.json")); await pricing.initialize();
    const requests: StreamChatRequest[] = [];
    const provider: Provider = { name: "fake", async *streamChat(request) { requests.push(request); yield { type: "done", stopReason: "end_turn" }; } };
    const providers = new ProviderRegistry(); providers.register(provider);
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClientLike;
    const runner = new AgentRunner(sessions, providers, core, new EventBus(), pricing, undefined, "zh-CN", 50, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, search);
    await runner.run(session.id, "check tools");
    return requests[0]?.tools.map((tool) => tool.name) ?? [];
  }

  it("always exposes web_fetch and only exposes configured web_search", async () => {
    const search: SearchProvider = { name: "fake", async search() { return []; } };
    const [withoutSearch, withSearch] = await Promise.all([exposedTools(), exposedTools(search)]);
    expect(withoutSearch).toContain("web_fetch");
    expect(withoutSearch).not.toContain("web_search");
    expect(withSearch).toContain("web_search");
  }, 15_000);
});
