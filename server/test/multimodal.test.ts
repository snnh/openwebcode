import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/agent-runner.js";
import { buildServer } from "../src/app.js";
import { ContextManager } from "../src/context/context-manager.js";
import { estimateMessageTokens, IMAGE_TOKEN_ESTIMATE } from "../src/context/model-profile.js";
import type { CoreClient } from "../src/core-client.js";
import { PricingCatalog } from "../src/cost/pricing-catalog.js";
import { EventBus } from "../src/events/event-bus.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { ProviderRegistry, type StreamChatRequest } from "../src/providers/provider.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { makeStubProvider } from "./helpers/stub-provider.js";
import { tempRoot } from "./helpers/temp-roots.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function userWithImage(text: string): ChatMessage {
  return {
    id: "u1",
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", data: PNG },
      { type: "text", text },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(messages: ChatMessage[]): StreamChatRequest {
  return { model: "claude-haiku-4-5", system: "s", messages, tools: [], signal: new AbortController().signal };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> { for await (const _ of iterable) { /* drain */ } }

describe("provider image mapping", () => {
  it("maps image blocks to Anthropic base64 image blocks", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    const bodies: Array<Record<string, unknown>> = [];
    const stream = (body: Record<string, unknown>) => {
      bodies.push(body);
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() { return { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" }; },
      };
    };
    (provider as unknown as { client: { messages: { stream: typeof stream } } }).client.messages.stream = stream;
    await drain(provider.streamChat(request([userWithImage("这是什么")])));
    const message = (bodies[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[0]!;
    expect(message.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } });
    expect(message.content[1]).toMatchObject({ type: "text", text: "这是什么" });
  });

  it("maps image blocks to OpenAI image_url parts and keeps string content when text-only", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: fetch as typeof globalThis.fetch });
    await drain(provider.streamChat(request([userWithImage("看图")])));
    const withImage = (bodies[0]!.messages as Array<Record<string, unknown>>)[1]!;
    expect(Array.isArray(withImage.content)).toBe(true);
    const parts = withImage.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
    expect(parts[1]).toMatchObject({ type: "text", text: "看图" });

    await drain(provider.streamChat(request([{ id: "u2", role: "user", content: [{ type: "text", text: "纯文本" }], createdAt: "2026-01-01T00:00:01.000Z" }])));
    const textOnly = (bodies[1]!.messages as Array<Record<string, unknown>>)[1]!;
    expect(textOnly.content).toBe("纯文本");
  });
});

describe("image token estimation and LRU budget", () => {
  it("estimates images at a fixed quota, not base64 length", () => {
    const big = "A".repeat(400_000);
    const tokens = estimateMessageTokens([{ id: "u", role: "user", content: [{ type: "image", mediaType: "image/png", data: big }], createdAt: "x" }]);
    expect(tokens).toBeLessThan(2_000);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
  });

  it("drops older images beyond the budget from the LLM view", async () => {
    const root = await tempRoot("owc-mm-");
    const context = new ContextManager(root);
    const messages: ChatMessage[] = Array.from({ length: 6 }, (_, index) => ({
      id: `u${index}`,
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: PNG }, { type: "text", text: `第 ${index} 张` }],
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
    }));
    const view = await context.buildView(messages);
    const images = view.messages.map((message) => message.content.filter((block) => block.type === "image").length);
    // 预算 4 张：最新的 4 条保留图片，更早的被占位文本替换
    expect(images).toEqual([0, 0, 1, 1, 1, 1]);
    expect(view.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("image omitted") });
    // 存储的原始消息不受影响
    expect(messages[0]!.content[0]).toMatchObject({ type: "image" });
  });
});

describe("messages route with images", () => {
  it("validates images and modality support", { timeout: 20_000 }, async () => {
    const root = await tempRoot("owc-mm-");
    const sessions = new SessionStore(path.join(root, "sessions"));
    await sessions.initialize();
    const pricing = new PricingCatalog(path.join(root, "pricing.json"));
    await pricing.initialize();
    const providers = new ProviderRegistry();
    providers.register(makeStubProvider("text-stub", async function* () {
      yield { type: "done", stopReason: "end_turn" };
    }));
    const events = new EventBus();
    const core = { on() { return core; }, async configureSession() { return { sandboxCapability: "advisory" }; } } as unknown as CoreClient;
    const agent = new AgentRunner(sessions, providers, core, events, pricing);
    const app = await buildServer({ core, sessions, agent, events, providers, pricing });
    try {
      // text-stub 的默认模型档案为纯文本：带图 400
      const textOnly = await sessions.create({ cwd: root, provider: "text-stub", title: "纯文本模型" });
      const rejected = await app.inject({ method: "POST", url: `/api/sessions/${textOnly.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<{ error: string }>().error).toContain("不支持图片");

      // metadata 前缀档案支持图片的模型：接受
      const capable = await sessions.create({ cwd: root, provider: "text-stub", model: "qwen-vl-plus", title: "带图模型" });
      const accepted = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "看图", images: [{ mediaType: "image/png", data: PNG }] } });
      expect(accepted.statusCode).toBe(202);
      let stored;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stored = await sessions.get(capable.id);
        if (stored?.messages.length) break;
      }
      expect(stored?.messages[0]?.content[0]).toMatchObject({ type: "image", mediaType: "image/png", data: PNG });

      const badType = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "x", images: [{ mediaType: "image/tiff", data: PNG }] } });
      expect(badType.statusCode).toBe(400);
      const tooMany = await app.inject({ method: "POST", url: `/api/sessions/${capable.id}/messages`, payload: { content: "x", images: Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: PNG })) } });
      expect(tooMany.statusCode).toBe(400);
      // POST /messages only acknowledges the background run.  Wait for it to
      // release the session files before afterEach removes the Windows temp dir.
      for (let attempt = 0; attempt < 60 && agent.isRunning(capable.id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(agent.isRunning(capable.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
