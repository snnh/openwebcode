import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ProviderRegistry } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "owc-provider-test-"));
  roots.push(root);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const providerProfiles = await ProviderProfilesService.load({ filePath: path.join(root, "provider-profiles.json") });
  const app = await buildServer({
    core: {} as CoreClient,
    sessions,
    agent: { isRunning: () => false } as unknown as AgentRunner,
    events: new EventBus(),
    providers: new ProviderRegistry(),
    pricing,
    providerProfiles,
  });
  return { root, app };
}

function stubFetchStatus(status: number): ReturnType<typeof vi.fn> {
  const handler = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", handler);
  return handler;
}

const openaiBody = { id: "测试服务", interfaceType: "openai-chat-completions", baseURL: "https://api.example.test/v1", apiKey: "sk-test" };
const anthropicBody = { id: "Claude", interfaceType: "anthropic-messages", apiKey: "sk-ant" };

function post(app: Awaited<ReturnType<typeof fixture>>["app"], payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/provider-profiles/test", payload });
}

describe("POST /api/provider-profiles/test", () => {
  it("openai 200：可达并返回延迟；请求打到 {baseURL}/models 并带 Bearer 头", async () => {
    const { app } = await fixture();
    try {
      const handler = stubFetchStatus(200);
      const response = await post(app, openaiBody);
      expect(response.statusCode).toBe(200);
      const body = response.json<{ ok: boolean; latencyMs: number }>();
      expect(body.ok).toBe(true);
      expect(typeof body.latencyMs).toBe("number");
      const [url, init] = handler.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.test/v1/models");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      expect(init.redirect).toBe("manual");
    } finally {
      await app.close();
    }
  });

  it("anthropic 200：使用免费的 GET /v1/models?limit=1 端点与 x-api-key 头，默认官方地址", async () => {
    const { app } = await fixture();
    try {
      const handler = stubFetchStatus(200);
      const response = await post(app, anthropicBody);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
      const [url, init] = handler.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      await app.close();
    }
  });

  it("401/403：分类为认证失败，提示检查 API Key", async () => {
    const { app } = await fixture();
    try {
      stubFetchStatus(401);
      const unauthorized = await post(app, openaiBody);
      expect(unauthorized.json()).toMatchObject({ ok: false, error: expect.stringContaining("认证失败") });
      stubFetchStatus(403);
      const forbidden = await post(app, openaiBody);
      expect(forbidden.json()).toMatchObject({ ok: false, error: expect.stringContaining("API Key") });
    } finally {
      await app.close();
    }
  });

  it("404：分类为接口不存在，提示检查 Base URL", async () => {
    const { app } = await fixture();
    try {
      stubFetchStatus(404);
      const response = await post(app, openaiBody);
      expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("Base URL") });
    } finally {
      await app.close();
    }
  });

  it("429：服务可达但限流，按连接成功处理并附提示", async () => {
    const { app } = await fixture();
    try {
      stubFetchStatus(429);
      const response = await post(app, openaiBody);
      const body = response.json<{ ok: boolean; note?: string }>();
      expect(body.ok).toBe(true);
      expect(body.note).toContain("429");
    } finally {
      await app.close();
    }
  });

  it("3xx 重定向：不自动跟随，提示检查 Base URL", async () => {
    const { app } = await fixture();
    try {
      stubFetchStatus(302);
      const response = await post(app, openaiBody);
      expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("重定向") });
    } finally {
      await app.close();
    }
  });

  it("超时：分类为连接超时", async () => {
    const { app } = await fixture();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out", "TimeoutError"); }));
      const response = await post(app, openaiBody);
      expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("超时") });
    } finally {
      await app.close();
    }
  });

  it("网络错误（ECONNREFUSED 等）：分类为无法连接", async () => {
    const { app } = await fixture();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      const response = await post(app, openaiBody);
      expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("无法连接") });
    } finally {
      await app.close();
    }
  });

  it("请求体校验失败：复用 provider-profiles 校验，返回 400 中文错误", async () => {
    const { app } = await fixture();
    try {
      const response = await post(app, { id: "坏配置", interfaceType: "graphql" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.stringContaining("接口类型") });

      const missingKey = await post(app, { id: "Claude", interfaceType: "anthropic-messages" });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.json()).toMatchObject({ error: expect.stringContaining("API Key") });
    } finally {
      await app.close();
    }
  });
});
