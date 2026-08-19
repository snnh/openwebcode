import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createOpenAIImageGenProvider,
  createProviderVisionProvider,
  resolveChatImageGenProvider,
  resolveChatVisionProvider,
} from "../src/chat/chat-media.js";
import type { ChatConfigService } from "../src/chat/chat-config.js";
import type { ChatPythonEnv } from "../src/chat/chat-python-env.js";
import { chatTools, calculateExpression, type ChatToolContext, type ImageGenProvider } from "../src/chat/chat-tools.js";
import type { ChatConfig } from "../src/chat/chat-types.js";
import type { ProviderProfilesService } from "../src/provider-profiles.js";
import { ProviderRegistry, type Provider, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import type { ChatMessage, MessageContent } from "../src/sessions/types.js";
import { ChatAssistantStore } from "../src/chat/chat-assistant-store.js";
import { ChatSessionStore } from "../src/chat/chat-session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

describe("chatTools", () => {
  it("returns all 10 tools", () => {
    const tools = chatTools();
    expect(tools.length).toBe(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain("time");
    expect(names).toContain("calculate");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("image_gen");
    expect(names).toContain("vision");
    expect(names).toContain("python");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("show");
  });

  it("categorizes tools correctly", () => {
    const tools = chatTools();
    const utility = tools.filter((t) => t.category === "utility").map((t) => t.name);
    const web = tools.filter((t) => t.category === "web").map((t) => t.name);
    const media = tools.filter((t) => t.category === "media").map((t) => t.name);
    const sandbox = tools.filter((t) => t.category === "sandbox").map((t) => t.name);

    expect(utility).toEqual(["time", "calculate"]);
    expect(web).toEqual(["web_search", "web_fetch"]);
    expect(media).toEqual(["image_gen", "vision"]);
    expect(sandbox).toEqual(["python", "read_file", "write_file", "show"]);
  });

  it("marks sandbox tools as requiring sandbox", () => {
    const tools = chatTools();
    const sandboxTools = tools.filter((t) => t.requiresSandbox);
    expect(sandboxTools.map((t) => t.name)).toEqual(["python", "read_file", "write_file", "show"]);
  });
});

describe("calculateExpression", () => {
  it("evaluates basic arithmetic", () => {
    expect(calculateExpression("1 + 2")).toBe(3);
    expect(calculateExpression("10 - 4")).toBe(6);
    expect(calculateExpression("3 * 4")).toBe(12);
    expect(calculateExpression("15 / 3")).toBe(5);
    expect(calculateExpression("10 % 3")).toBe(1);
  });

  it("handles operator precedence", () => {
    expect(calculateExpression("2 + 3 * 4")).toBe(14);
    expect(calculateExpression("(2 + 3) * 4")).toBe(20);
    expect(calculateExpression("2 ^ 3 ^ 2")).toBe(512);
  });

  it("handles unary operators", () => {
    expect(calculateExpression("-5")).toBe(-5);
    expect(calculateExpression("--5")).toBe(5);
    expect(calculateExpression("-3 + 7")).toBe(4);
  });

  it("evaluates functions", () => {
    expect(calculateExpression("sqrt(16)")).toBe(4);
    expect(calculateExpression("abs(-5)")).toBe(5);
    expect(calculateExpression("sin(0)")).toBe(0);
    expect(calculateExpression("cos(0)")).toBe(1);
    expect(calculateExpression("log(100)")).toBe(2);
    expect(calculateExpression("ln(2.718281828459045)")).toBeCloseTo(1);
  });

  it("handles constants", () => {
    expect(calculateExpression("pi")).toBeCloseTo(Math.PI);
    expect(calculateExpression("e")).toBeCloseTo(Math.E);
  });

  it("rejects invalid expressions", () => {
    expect(() => calculateExpression("")).toThrow();
    expect(() => calculateExpression("abc")).toThrow();
    expect(() => calculateExpression("1 +")).toThrow();
    expect(() => calculateExpression("()")).toThrow();
  });
});

function makeCtx(sessionDir: string, overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    searchProvider: undefined,
    webFetchProvider: undefined,
    getImageGenProvider: async () => undefined,
    getVisionProvider: async () => undefined,
    pythonEnv: {} as ChatPythonEnv,
    sessionDir,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function message(content: MessageContent[]): ChatMessage {
  return { id: randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
}

function fakeConfig(config: ChatConfig): ChatConfigService {
  return { get: () => Promise.resolve(config) } as ChatConfigService;
}

const visionTool = () => chatTools().find((t) => t.name === "vision")!;
const imageGenTool = () => chatTools().find((t) => t.name === "image_gen")!;

describe("vision 工具", () => {
  it("未配置 visionModel 时返回 not configured 错误文本", async () => {
    const root = await tempRoot("owc-chat-media-");
    const out = await visionTool().handler({ prompt: "描述" }, makeCtx(root));
    expect(out[0]).toEqual({ type: "text", text: "Error: vision is not configured" });
  });

  it("source 省略时回溯会话最近一张图片块", async () => {
    const root = await tempRoot("owc-chat-media-");
    const seen: { data: string; mediaType: string }[] = [];
    const provider = {
      name: "fake",
      analyze: (image: { data: string; mediaType: string }, _prompt: string) => {
        seen.push(image);
        return Promise.resolve("是一只猫");
      },
    };
    const messages = [
      message([{ type: "image", data: "b2xk", mediaType: "image/png" }]),
      message([{ type: "text", text: "中间消息" }]),
      message([{ type: "image", data: "bmV3", mediaType: "image/webp" }]),
    ];
    const ctx = makeCtx(root, { getVisionProvider: async () => provider, messages });
    const out = await visionTool().handler({ prompt: "这是什么" }, ctx);
    expect(seen).toEqual([{ data: "bmV3", mediaType: "image/webp" }]);
    expect(out[0]).toEqual({ type: "text", text: "是一只猫" });
  });

  it("source 省略且会话无图时报错", async () => {
    const root = await tempRoot("owc-chat-media-");
    const provider = { name: "fake", analyze: () => Promise.resolve("x") };
    const ctx = makeCtx(root, { getVisionProvider: async () => provider, messages: [message([{ type: "text", text: "hi" }])] });
    await expect(visionTool().handler({ prompt: "p" }, ctx)).rejects.toThrow(/No image found/);
  });

  it("source 为会话相对路径时读文件（按扩展名判 mediaType）", async () => {
    const root = await tempRoot("owc-chat-media-");
    await mkdir(path.join(root, "uploads"), { recursive: true });
    await writeFile(path.join(root, "uploads", "pic.png"), Buffer.from([1, 2, 3]));
    const seen: { data: string; mediaType: string }[] = [];
    const provider = {
      name: "fake",
      analyze: (image: { data: string; mediaType: string }) => { seen.push(image); return Promise.resolve("ok"); },
    };
    const ctx = makeCtx(root, { getVisionProvider: async () => provider });
    await visionTool().handler({ source: "uploads/pic.png", prompt: "p" }, ctx);
    expect(seen[0]).toEqual({ data: Buffer.from([1, 2, 3]).toString("base64"), mediaType: "image/png" });
  });

  it("source 越界路径被拒绝（../ 穿越）", async () => {
    const root = await tempRoot("owc-chat-media-");
    const provider = { name: "fake", analyze: () => Promise.resolve("x") };
    const ctx = makeCtx(root, { getVisionProvider: async () => provider });
    await expect(visionTool().handler({ source: "../secret.png", prompt: "p" }, ctx)).rejects.toThrow(/escapes session directory/);
  });

  it("source 为 http(s) URL 时经 server 出网抓取", async () => {
    const root = await tempRoot("owc-chat-media-");
    const seen: { data: string; mediaType: string }[] = [];
    const provider = {
      name: "fake",
      analyze: (image: { data: string; mediaType: string }) => { seen.push(image); return Promise.resolve("ok"); },
    };
    const requested: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      requested.push(String(input));
      return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    const ctx = makeCtx(root, { getVisionProvider: async () => provider, fetchImpl });
    await visionTool().handler({ source: "https://example.com/pic.jpg", prompt: "p" }, ctx);
    expect(requested).toEqual(["https://example.com/pic.jpg"]);
    expect(seen[0]).toEqual({ data: Buffer.from([9, 8, 7]).toString("base64"), mediaType: "image/jpeg" });
  });

  it("URL 抓取拒绝非图片响应与内网地址", async () => {
    const root = await tempRoot("owc-chat-media-");
    const provider = { name: "fake", analyze: () => Promise.resolve("x") };
    const fetchImpl = (async () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;
    const ctx = makeCtx(root, { getVisionProvider: async () => provider, fetchImpl });
    await expect(visionTool().handler({ source: "https://example.com/page", prompt: "p" }, ctx)).rejects.toThrow(/did not return an image/);
    await expect(visionTool().handler({ source: "http://127.0.0.1/x.png", prompt: "p" }, ctx)).rejects.toThrow(/not allowed/);
  });

  it("reasoning 非法值抛错", async () => {
    const root = await tempRoot("owc-chat-media-");
    const provider = { name: "fake", analyze: () => Promise.resolve("x") };
    const ctx = makeCtx(root, { getVisionProvider: async () => provider, messages: [message([{ type: "image", data: "eA==", mediaType: "image/png" }])] });
    await expect(visionTool().handler({ prompt: "p", reasoning: "max" }, ctx)).rejects.toThrow(/Invalid reasoning/);
  });
});

describe("vision 适配器（provider chat 通路）", () => {
  function captureProvider(): { provider: Provider; requests: StreamChatRequest[] } {
    const requests: StreamChatRequest[] = [];
    const provider: Provider = {
      name: "vp",
      streamChat: (request) => {
        requests.push(request);
        return (async function* (): AsyncIterable<ProviderEvent> {
          yield { type: "text_delta", text: "答案" };
          yield { type: "done", stopReason: "end_turn" };
        })();
      },
    };
    return { provider, requests };
  }

  it("构造单条 user 消息（image + prompt），收集流式文本", async () => {
    const { provider, requests } = captureProvider();
    const vision = createProviderVisionProvider({ name: "vp", model: "vm", provider });
    const answer = await vision.analyze({ data: "aGk=", mediaType: "image/png" }, "看到了什么");
    expect(answer).toBe("答案");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.model).toBe("vm");
    expect(request.tools).toEqual([]);
    const content = request.messages[0]!.content;
    expect(content[0]).toEqual({ type: "image", data: "aGk=", mediaType: "image/png" });
    expect(content[1]).toEqual({ type: "text", text: "看到了什么" });
  });

  it("reasoning 映射：off → thinking disabled；high → enabled + effort", async () => {
    const { provider, requests } = captureProvider();
    const vision = createProviderVisionProvider({ name: "vp", model: "vm", provider });
    await vision.analyze({ data: "aGk=", mediaType: "image/png" }, "q1");
    expect(requests[0]!.thinking).toBe("disabled");
    expect(requests[0]!.effort).toBeUndefined();
    await vision.analyze({ data: "aGk=", mediaType: "image/png" }, "q2", { reasoning: "high" });
    expect(requests[1]!.thinking).toBe("enabled");
    expect(requests[1]!.effort).toBe("high");
    await vision.analyze({ data: "aGk=", mediaType: "image/png" }, "q3", { reasoning: "low" });
    expect(requests[2]!.thinking).toBe("enabled");
    expect(requests[2]!.effort).toBe("low");
  });
});

describe("image_gen 工具", () => {
  it("未配置 imageGenModel 时返回 not configured 错误文本", async () => {
    const root = await tempRoot("owc-chat-media-");
    const out = await imageGenTool().handler({ prompt: "画只猫" }, makeCtx(root));
    expect(out[0]).toEqual({ type: "text", text: "Error: image generation is not configured" });
  });

  it("产出落盘 generated/ 并内联返回（块带 ref）", async () => {
    const root = await tempRoot("owc-chat-media-");
    const pngBytes = Buffer.from([137, 80, 78, 71]);
    const provider: ImageGenProvider = {
      name: "fake",
      generate: () => Promise.resolve({ data: pngBytes.toString("base64"), mediaType: "image/png" }),
    };
    const ctx = makeCtx(root, { getImageGenProvider: async () => provider });
    const out = await imageGenTool().handler({ prompt: "画只猫" }, ctx);
    expect(out).toHaveLength(1);
    const block = out[0]!;
    if (block.type !== "image") throw new Error("expected image block");
    expect(block.data).toBe(pngBytes.toString("base64"));
    expect(block.mediaType).toBe("image/png");
    expect(block.ref).toMatch(/^generated\/[0-9a-f-]+\.png$/);
    const written = await readFile(path.join(root, block.ref!));
    expect(written.equals(pngBytes)).toBe(true);
  });

  it("aspectRatio 非法值抛错", async () => {
    const root = await tempRoot("owc-chat-media-");
    const provider: ImageGenProvider = { name: "fake", generate: () => Promise.resolve({ data: "eA==", mediaType: "image/png" }) };
    const ctx = makeCtx(root, { getImageGenProvider: async () => provider });
    await expect(imageGenTool().handler({ prompt: "p", aspectRatio: "4:3" }, ctx)).rejects.toThrow(/Invalid aspectRatio/);
  });
});

describe("image_gen 适配器（OpenAI images API）", () => {
  function captureFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("请求形状：POST <baseURL>/images/generations，b64_json，Bearer 凭据", async () => {
    const { fetchImpl, calls } = captureFetch({ data: [{ b64_json: "aGk=" }] });
    const provider = createOpenAIImageGenProvider({ name: "p", model: "gpt-image-1", baseURL: "https://api.example.com/v1/", apiKey: "sk-test", fetchImpl });
    const result = await provider.generate("画只猫");
    expect(result).toEqual({ data: "aGk=", mediaType: "image/png" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.example.com/v1/images/generations");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const payload = JSON.parse(String(init?.body));
    expect(payload).toEqual({ model: "gpt-image-1", prompt: "画只猫", n: 1, size: "1024x1024", response_format: "b64_json" });
  });

  it.each([
    ["1:1", "1024x1024"],
    ["3:2", "1216x832"],
    ["2:3", "832x1216"],
    ["16:9", "1344x768"],
    ["9:16", "768x1344"],
  ] as const)("aspectRatio %s → size %s", async (aspectRatio, size) => {
    const { fetchImpl, calls } = captureFetch({ data: [{ b64_json: "aGk=" }] });
    const provider = createOpenAIImageGenProvider({ name: "p", model: "m", baseURL: "https://api.example.com/v1", fetchImpl });
    await provider.generate("p", { aspectRatio });
    expect(JSON.parse(String(calls[0]!.init?.body)).size).toBe(size);
  });

  it("provider 错误如实透传（HTTP 状态 + 响应摘要）", async () => {
    const { fetchImpl } = captureFetch({ error: { message: "invalid size" } }, 400);
    const provider = createOpenAIImageGenProvider({ name: "p", model: "m", baseURL: "https://api.example.com/v1", fetchImpl });
    await expect(provider.generate("p")).rejects.toThrow(/Image generation failed: HTTP 400.*invalid size/);
  });

  it("响应无 b64_json 时报错", async () => {
    const { fetchImpl } = captureFetch({ data: [{}] });
    const provider = createOpenAIImageGenProvider({ name: "p", model: "m", baseURL: "https://api.example.com/v1", fetchImpl });
    await expect(provider.generate("p")).rejects.toThrow(/no image data/);
  });
});

describe("media 适配器现读（chat.json 热生效）", () => {
  it("imageGenModel 未配置/服务商缺失时返回 undefined；命中时携带凭据", async () => {
    expect(await resolveChatImageGenProvider(fakeConfig({}), undefined)).toBeUndefined();
    const profiles = {
      modelProfiles: () => [
        { id: "img", enabled: true, interfaceType: "openai-chat-completions", apiKey: "sk-x", baseURL: "https://img.example.com/v1" },
        { id: "off", enabled: false, interfaceType: "openai-chat-completions" },
      ],
    } as unknown as ProviderProfilesService;
    expect(await resolveChatImageGenProvider(fakeConfig({ imageGenModel: { provider: "off", model: "m" } }), profiles)).toBeUndefined();
    const provider = await resolveChatImageGenProvider(fakeConfig({ imageGenModel: { provider: "img", model: "m" } }), profiles);
    expect(provider?.name).toBe("img");
  });

  it("visionModel 未配置/provider 未注册时返回 undefined；命中时返回适配器", async () => {
    const registry = new ProviderRegistry();
    expect(await resolveChatVisionProvider(fakeConfig({}), registry)).toBeUndefined();
    expect(await resolveChatVisionProvider(fakeConfig({ visionModel: { provider: "ghost", model: "m" } }), registry)).toBeUndefined();
    registry.register({ name: "vp", streamChat: () => (async function* () { /* empty */ })() });
    const provider = await resolveChatVisionProvider(fakeConfig({ visionModel: { provider: "vp", model: "m" } }), registry);
    expect(provider?.name).toBe("vp");
  });
});

describe("ChatSessionStore", () => {
  let dir: string;
  let store: ChatSessionStore;

  beforeEach(async () => {
    dir = await tempRoot("chat-test-");
    store = new ChatSessionStore(dir);
  });

  it("creates and retrieves a session", async () => {
    const meta = await store.create({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.provider).toBe("anthropic");
    expect(meta.title).toBe("New chat");

    const retrieved = await store.get(meta.id);
    expect(retrieved?.id).toBe(meta.id);
  });

  it("lists sessions sorted by updatedAt desc", async () => {
    const s1 = await store.create({ provider: "a", model: "m1" });
    const s2 = await store.create({ provider: "a", model: "m2" });
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(s2.id);
    expect(list[1]!.id).toBe(s1.id);
  });

  it("renames a session", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const renamed = await store.rename(meta.id, "My Chat");
    expect(renamed.title).toBe("My Chat");
  });

  it("deletes a session", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.delete(meta.id);
    expect(await store.get(meta.id)).toBeUndefined();
  });

  it("appends messages and derives title from first user message", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "Hello world this is a test message" }]);

    const updated = await store.get(meta.id);
    expect(updated?.title).toBe("Hello world this is a test message");

    const messages = await store.getMessages(meta.id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("maintains parentId chain for session tree", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msg1 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    const msg2 = await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);
    const msg3 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "Second" }]);

    expect(msg2.parentId).toBe(msg1.id);
    expect(msg3.parentId).toBe(msg2.id);
  });

  it("branches a session (copies active path)", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "Question" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Answer" }]);

    const branch = await store.branch(meta.id);
    expect(branch.id).not.toBe(meta.id);

    const branchMessages = await store.getMessages(branch.id);
    expect(branchMessages.length).toBe(2);
    expect(branchMessages[0]!.content[0]!.type).toBe("text");
  });

  it("checkouts to a specific message", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msg1 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);

    const checked = await store.checkout(meta.id, msg1.id);
    expect(checked.activeLeafId).toBe(msg1.id);
  });

  it("checkout rejects a non-existent messageId", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await expect(store.checkout(meta.id, "does-not-exist")).rejects.toThrow("Message not found");
  });

  it("retries from a user message (backtracks activeLeaf)", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    await store.appendMessage(meta.id, "user", [{ type: "text", text: "First" }]);
    await store.appendMessage(meta.id, "assistant", [{ type: "text", text: "Response" }]);
    const msg3 = await store.appendMessage(meta.id, "user", [{ type: "text", text: "Second" }]);

    const retried = await store.retry(meta.id, msg3.id);
    expect(retried.activeLeafId).not.toBe(msg3.id);
  });

  it("rejects invalid session IDs", async () => {
    await expect(store.get("../etc/passwd")).rejects.toThrow();
    await expect(store.get("not-a-uuid")).rejects.toThrow();
  });

  it("paginates messages with getMessagesBefore", async () => {
    const meta = await store.create({ provider: "a", model: "m" });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await store.appendMessage(meta.id, "user", [{ type: "text", text: `Message ${i}` }]));
    }

    const before = await store.getMessagesBefore(meta.id, msgs[5]!.id, 3);
    expect(before.length).toBeLessThanOrEqual(3);
  });
});

describe("ChatAssistantStore", () => {
  let dir: string;
  let store: ChatAssistantStore;

  beforeEach(async () => {
    dir = await tempRoot("chat-asst-");
    store = new ChatAssistantStore(path.join(dir, "assistants.json"));
    await store.init();
  });

  it("creates default assistants on first init", async () => {
    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.name === "通用助手")).toBe(true);
    expect(list.some((a) => a.name === "编程助手")).toBe(true);
  });

  it("creates a custom assistant", async () => {
    const asst = await store.create({
      name: "Test Assistant",
      systemPrompt: "You are a test bot",
      temperature: 0.5,
    });
    expect(asst.id).toBeDefined();
    expect(asst.name).toBe("Test Assistant");
    expect(asst.temperature).toBe(0.5);
  });

  it("updates an assistant", async () => {
    const asst = await store.create({ name: "Original", systemPrompt: "Original prompt" });
    const updated = await store.update(asst.id, { name: "Updated", temperature: 0.8 });
    expect(updated.name).toBe("Updated");
    expect(updated.temperature).toBe(0.8);
    expect(updated.systemPrompt).toBe("Original prompt");
  });

  it("deletes an assistant", async () => {
    const asst = await store.create({ name: "ToDelete", systemPrompt: "" });
    await store.delete(asst.id);
    expect(await store.get(asst.id)).toBeUndefined();
  });

  it("persists across store instances", async () => {
    await store.create({ name: "Persistent", systemPrompt: "test" });
    const store2 = new ChatAssistantStore(path.join(dir, "assistants.json"));
    await store2.init();
    const list = await store2.list();
    expect(list.some((a) => a.name === "Persistent")).toBe(true);
  });
});
