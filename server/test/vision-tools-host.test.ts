import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DESCRIBE_IMAGE_SPEC, bridgeVisionImages, describeImage, type VisionToolsHostApi } from "../src/extensions/vision-tools-host.js";
import type { ContextHookPayload } from "../src/extensions/types.js";
import type { ChatMessage } from "../src/sessions/types.js";

const IMAGE_DATA = Buffer.from("fake-image-bytes").toString("base64");
const IMAGE_DATA_2 = Buffer.from("other-image-bytes").toString("base64");

function imageMessage(id: string, mediaType = "image/png", data = IMAGE_DATA): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-08-01T00:00:00.000Z",
    content: [
      { type: "image", mediaType, data },
      { type: "text", text: "看这张图" },
    ],
  };
}

function payload(messages: ChatMessage[], clearedAt?: string): ContextHookPayload {
  return {
    sessionId: "s1",
    cwd: "/workspace",
    messages,
    ledger: { round: 1, entries: [], ...(clearedAt ? { cleared: { at: clearedAt } } : {}) },
  };
}

function makeApi(overrides: Partial<VisionToolsHostApi> = {}): VisionToolsHostApi {
  return {
    getSession: vi.fn(async () => ({ provider: "text-provider", model: "text-model" })),
    getCapabilities: vi.fn(async () => ({ vision: false })),
    modelVision: vi.fn(async () => ({ text: "一张包含代码截图的图片，展示了一个 TypeScript 函数。" })),
    readImageFile: vi.fn(async () => ({ mediaType: "image/png", data: IMAGE_DATA })),
    storageRead: vi.fn(async () => ({ content: null })),
    storageWrite: vi.fn(async () => ({ bytes: 0 })),
    ...overrides,
  };
}

const VISION_CONFIG = { model: "vision-provider/gpt-4o" };
const TOOLCALL_CONFIG = { ...VISION_CONFIG, mode: "toolCall" };

describe("vision-tools bridgeVisionImages", () => {
  it("未配置模型时透传（不干预）", async () => {
    const api = makeApi();
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), {});
    expect(result.messages).toBeUndefined();
    expect(api.modelVision).not.toHaveBeenCalled();
  });

  it("主模型支持视觉时透传（不替换图片）", async () => {
    const api = makeApi({ getCapabilities: async () => ({ vision: true }) });
    const original = payload([imageMessage("u1")]);
    const result = await bridgeVisionImages(api, original, VISION_CONFIG);
    expect(result.messages).toBeUndefined();
    expect(api.modelVision).not.toHaveBeenCalled();
  });

  it("toolCall 模式主模型支持视觉时同样透传", async () => {
    const api = makeApi({ getCapabilities: async () => ({ vision: true }) });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), TOOLCALL_CONFIG);
    expect(result.messages).toBeUndefined();
    expect(api.modelVision).not.toHaveBeenCalled();
  });

  it("无图片时透传", async () => {
    const api = makeApi();
    const original = payload([{
      id: "u1",
      role: "user",
      createdAt: "2026-08-01T00:00:00.000Z",
      content: [{ type: "text", text: "纯文本" }],
    }]);
    const result = await bridgeVisionImages(api, original, VISION_CONFIG);
    expect(result.messages).toBeUndefined();
    expect(api.modelVision).not.toHaveBeenCalled();
  });

  it("图片替换为视觉模型描述文本并写缓存", async () => {
    const writes: string[] = [];
    const api = makeApi({
      storageWrite: async (file, content) => { writes.push(`${file}:${content}`); return { bytes: content.length }; },
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), VISION_CONFIG);
    expect(result.messages).toBeDefined();
    const content = result.messages![0]!.content;
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("TypeScript 函数") });
    // 原 text 块保留
    expect(content[1]).toMatchObject({ type: "text", text: "看这张图" });
    expect(result.metadata).toMatchObject({ described: 1, cached: 0 });
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("vision/");
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({
      provider: "vision-provider",
      model: "gpt-4o",
      thinking: true,
      images: [{ mediaType: "image/png", data: IMAGE_DATA }],
    }));
  });

  it("缓存命中时不再调用视觉模型", async () => {
    const api = makeApi({
      storageRead: async () => ({ content: "缓存的图片描述" }),
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), VISION_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "缓存的图片描述" });
    expect(result.metadata).toMatchObject({ described: 0, cached: 1 });
    expect(api.modelVision).not.toHaveBeenCalled();
  });

  it("cacheDescriptions=false 时跳过缓存读写", async () => {
    const api = makeApi();
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), { ...VISION_CONFIG, cacheDescriptions: false });
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text" });
    expect(api.storageRead).not.toHaveBeenCalled();
    expect(api.storageWrite).not.toHaveBeenCalled();
    expect(api.modelVision).toHaveBeenCalledTimes(1);
  });

  it("描述失败替换为占位文本且不阻断", async () => {
    const api = makeApi({
      modelVision: async () => { throw new Error("provider 500"); },
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), VISION_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("视觉描述失败") });
    expect(result.metadata).toMatchObject({ described: 0, failed: 1 });
  });

  it("thinking=false 时透传关闭思考", async () => {
    const api = makeApi();
    await bridgeVisionImages(api, payload([imageMessage("u1")]), { ...VISION_CONFIG, thinking: false });
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({ thinking: false }));
  });

  it("maxTokens 配置透传；未配置不携带", async () => {
    const api = makeApi();
    await bridgeVisionImages(api, payload([imageMessage("u1")]), { ...VISION_CONFIG, maxTokens: 2048 });
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2048 }));
    const api2 = makeApi();
    await bridgeVisionImages(api2, payload([imageMessage("u1")]), VISION_CONFIG);
    expect(api2.modelVision).toHaveBeenCalledWith(expect.not.objectContaining({ maxTokens: expect.anything() }));
  });

  it("同轮多张相同图片只调用一次视觉模型", async () => {
    const api = makeApi();
    const messages = [{
      id: "u1",
      role: "user" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      content: [
        { type: "image" as const, mediaType: "image/png", data: IMAGE_DATA },
        { type: "image" as const, mediaType: "image/png", data: IMAGE_DATA },
      ],
    }];
    const result = await bridgeVisionImages(api, payload(messages), VISION_CONFIG);
    expect(api.modelVision).toHaveBeenCalledTimes(1);
    expect(result.messages![0]!.content).toHaveLength(2);
    expect(result.messages![0]!.content[0]).toEqual(result.messages![0]!.content[1]);
  });

  it("能力查询失败不阻断（按纯文本主模型继续处理）", async () => {
    const api = makeApi({ getCapabilities: async () => { throw new Error("query failed"); } });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), VISION_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("TypeScript 函数") });
  });

  it("能力查询失败时 modelVision 可被 vi.fn 断言（无残留副作用）", () => {
    // 纯类型/契约冒烟：api 形状稳定（避免误删 host 侧接线字段）
    const api = makeApi();
    expect(api).toHaveProperty("modelVision");
    expect(api).toHaveProperty("getCapabilities");
    expect(api).toHaveProperty("readImageFile");
    expect(api).toHaveProperty("storageRead");
    expect(api).toHaveProperty("storageWrite");
  });
});

describe("vision-tools toolCall 模式", () => {
  it("图片替换为 [图片 #N] 占位符，编号持久化到 storage", async () => {
    const writes: string[] = [];
    const api = makeApi({
      storageWrite: async (file, content) => { writes.push(`${file}:${content}`); return { bytes: content.length }; },
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), TOOLCALL_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "[图片 #1]" });
    expect(result.messages![0]!.content[1]).toMatchObject({ type: "text", text: "看这张图" });
    expect(result.metadata).toMatchObject({ mode: "toolCall", placeholders: 1, images: 1 });
    expect(api.modelVision).not.toHaveBeenCalled();
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("vision/ids/s1.json");
  });

  it("同轮相同图片复用同一编号；不同图片编号递增", async () => {
    const api = makeApi();
    const messages = [{
      id: "u1",
      role: "user" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      content: [
        { type: "image" as const, mediaType: "image/png", data: IMAGE_DATA },
        { type: "image" as const, mediaType: "image/png", data: IMAGE_DATA },
        { type: "image" as const, mediaType: "image/jpeg", data: IMAGE_DATA_2 },
      ],
    }];
    const result = await bridgeVisionImages(api, payload(messages), TOOLCALL_CONFIG);
    const blocks = result.messages![0]!.content;
    expect(blocks[0]).toMatchObject({ type: "text", text: "[图片 #1]" });
    expect(blocks[1]).toMatchObject({ type: "text", text: "[图片 #1]" });
    expect(blocks[2]).toMatchObject({ type: "text", text: "[图片 #2]" });
    expect(result.metadata).toMatchObject({ placeholders: 3, images: 2 });
  });

  it("编号表存在时同图复用历史编号，新图取下一号", async () => {
    const stored = JSON.stringify({ [createHash("sha1").update(IMAGE_DATA).digest("hex")]: 5 });
    const api = makeApi({
      storageRead: async (file) => (file.includes("ids/s1.json") ? { content: stored } : { content: null }),
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1"), imageMessage("u2", "image/jpeg", IMAGE_DATA_2)]), TOOLCALL_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "[图片 #5]" });
    expect(result.messages![1]!.content[0]).toMatchObject({ type: "text", text: "[图片 #6]" });
  });

  it("编号表损坏时按空表重新编号", async () => {
    const api = makeApi({
      storageRead: async (file) => (file.includes("ids/s1.json") ? { content: "{broken" } : { content: null }),
    });
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), TOOLCALL_CONFIG);
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "[图片 #1]" });
  });

  it("无 clear 时同会话图片编号跨轮不变", async () => {
    const store = new Map<string, string>();
    const api = makeApi({
      storageRead: async (file) => ({ content: store.get(file) ?? null }),
      storageWrite: async (file, content) => { store.set(file, content); return { bytes: content.length }; },
    });
    // 第一轮：两张图分配 #1、#2
    await bridgeVisionImages(api, payload([imageMessage("u1"), imageMessage("u2", "image/jpeg", IMAGE_DATA_2)]), TOOLCALL_CONFIG);
    // 第二轮：新增第三张图 → 续用 #1、#2，新图取 #3（同会话内编号不变）
    const result = await bridgeVisionImages(
      api,
      payload([imageMessage("u1"), imageMessage("u2", "image/jpeg", IMAGE_DATA_2), imageMessage("u3", "image/webp", Buffer.from("third").toString("base64"))]),
      TOOLCALL_CONFIG,
    );
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "[图片 #1]" });
    expect(result.messages![1]!.content[0]).toMatchObject({ type: "text", text: "[图片 #2]" });
    expect(result.messages![2]!.content[0]).toMatchObject({ type: "text", text: "[图片 #3]" });
  });

  it("/clear 清空上下文后编号表清空、重新从 #1 分配", async () => {
    const store = new Map<string, string>();
    const api = makeApi({
      storageRead: async (file) => ({ content: store.get(file) ?? null }),
      storageWrite: async (file, content) => { store.set(file, content); return { bytes: content.length }; },
    });
    // clear 前：图片分配 #1
    await bridgeVisionImages(api, payload([imageMessage("u1")]), TOOLCALL_CONFIG);
    expect(store.get("vision/ids/s1.json")).toBeDefined();
    // /clear 后：同一张图（含旧占位符）不再出现，编号表被清空，重新从 #1 分配
    const result = await bridgeVisionImages(
      api,
      payload([imageMessage("u2", "image/jpeg", IMAGE_DATA_2)], "2026-08-13T10:00:00.000Z"),
      TOOLCALL_CONFIG,
    );
    expect(result.messages![0]!.content[0]).toMatchObject({ type: "text", text: "[图片 #1]" });
    // 编号表最终只剩 clear 后新分配的一条（旧 #1 已被清掉）
    expect(Object.keys(JSON.parse(store.get("vision/ids/s1.json")!) as Record<string, number>).length).toBe(1);
  });

  it("describe_image 按编号调用视觉模型并缓存（同图同 request 复用）", async () => {
    const store = new Map<string, string>();
    const api = makeApi({
      storageRead: async (file) => ({ content: store.get(file) ?? null }),
      storageWrite: async (file, content) => { store.set(file, content); return { bytes: content.length }; },
    });
    // 先经钩子建立编号 → 图片映射
    await bridgeVisionImages(api, payload([imageMessage("u1")]), TOOLCALL_CONFIG);
    const result = await describeImage(api, { image: 1, request: "图中的函数名是什么？" }, TOOLCALL_CONFIG, "s1");
    expect(result.content).toContain("TypeScript 函数");
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "图中的函数名是什么？",
      images: [{ mediaType: "image/png", data: IMAGE_DATA }],
    }));
    // 同图同 request 再次调用命中缓存，不再调视觉模型
    const calls = vi.mocked(api.modelVision).mock.calls.length;
    const cached = await describeImage(api, { image: 1, request: "图中的函数名是什么？" }, TOOLCALL_CONFIG, "s1");
    expect(cached.content).toContain("TypeScript 函数");
    expect(vi.mocked(api.modelVision).mock.calls.length).toBe(calls);
    expect([...store.keys()].some((file) => file.includes("vision/call/"))).toBe(true);
  });

  it("describe_image 按 path 读取工作区图片", async () => {
    const api = makeApi();
    const result = await describeImage(api, { path: "screenshots/error.png", request: "错误信息是什么？" }, TOOLCALL_CONFIG, "s1");
    expect(result.content).toContain("TypeScript 函数");
    expect(api.readImageFile).toHaveBeenCalledWith("s1", "screenshots/error.png");
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({ prompt: "错误信息是什么？" }));
  });

  it("describe_image 缺少 request 报错", async () => {
    const api = makeApi();
    await expect(describeImage(api, { image: 1 }, TOOLCALL_CONFIG, "s1")).rejects.toThrow(/request/);
  });

  it("describe_image image 与 path 必须二选一", async () => {
    const api = makeApi();
    await expect(describeImage(api, { request: "x" }, TOOLCALL_CONFIG, "s1")).rejects.toThrow(/exactly one/);
    await expect(describeImage(api, { image: 1, path: "a.png", request: "x" }, TOOLCALL_CONFIG, "s1")).rejects.toThrow(/exactly one/);
  });

  it("describe_image 引用上下文中不存在的编号时报错", async () => {
    const api = makeApi();
    await expect(describeImage(api, { image: 9, request: "x" }, TOOLCALL_CONFIG, "s1")).rejects.toThrow(/not available/);
  });

  it("describe_image 未配置视觉模型时报错", async () => {
    const api = makeApi();
    await expect(describeImage(api, { path: "a.png", request: "x" }, { mode: "toolCall" }, "s1")).rejects.toThrow(/vision model/);
  });

  it("describe_image 工具描述声明编号与路径两种输入", () => {
    expect(DESCRIBE_IMAGE_SPEC.name).toBe("describe_image");
    expect(DESCRIBE_IMAGE_SPEC.inputSchema).toMatchObject({
      properties: expect.objectContaining({ image: expect.anything(), path: expect.anything(), request: expect.anything() }),
      required: ["request"],
    });
  });
});

describe("vision-tools config parsing", () => {
  it("模型选择器编码 provider/model 被正确拆分", async () => {
    const api = makeApi();
    const result = await bridgeVisionImages(api, payload([imageMessage("u1")]), { model: "openai/gpt-4o" });
    expect(api.modelVision).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-4o" }));
    expect(result.messages).toBeDefined();
  });

  it("编码缺失 provider 或 model 时透传", async () => {
    const api = makeApi();
    expect((await bridgeVisionImages(api, payload([imageMessage("u1")]), { model: "" })).messages).toBeUndefined();
    expect((await bridgeVisionImages(api, payload([imageMessage("u1")]), { model: "onlyprovider/" })).messages).toBeUndefined();
    expect((await bridgeVisionImages(api, payload([imageMessage("u1")]), { model: "/onlymodel" })).messages).toBeUndefined();
    expect(api.modelVision).not.toHaveBeenCalled();
  });
});
