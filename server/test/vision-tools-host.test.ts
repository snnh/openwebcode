import { describe, expect, it, vi } from "vitest";
import { bridgeVisionImages, type VisionToolsHostApi } from "../src/extensions/vision-tools-host.js";
import type { ContextHookPayload } from "../src/extensions/types.js";
import type { ChatMessage } from "../src/sessions/types.js";

const IMAGE_DATA = Buffer.from("fake-image-bytes").toString("base64");

function imageMessage(id: string, mediaType = "image/png"): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-08-01T00:00:00.000Z",
    content: [
      { type: "image", mediaType, data: IMAGE_DATA },
      { type: "text", text: "看这张图" },
    ],
  };
}

function payload(messages: ChatMessage[]): ContextHookPayload {
  return {
    sessionId: "s1",
    cwd: "/workspace",
    messages,
    ledger: { round: 1, entries: [] },
  };
}

function makeApi(overrides: Partial<VisionToolsHostApi> = {}): VisionToolsHostApi {
  return {
    getSession: vi.fn(async () => ({ provider: "text-provider", model: "text-model" })),
    getCapabilities: vi.fn(async () => ({ vision: false })),
    modelVision: vi.fn(async () => ({ text: "一张包含代码截图的图片，展示了一个 TypeScript 函数。" })),
    storageRead: vi.fn(async () => ({ content: null })),
    storageWrite: vi.fn(async () => ({ bytes: 0 })),
    ...overrides,
  };
}

const VISION_CONFIG = { model: "vision-provider/gpt-4o" };

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
    expect(api).toHaveProperty("storageRead");
    expect(api).toHaveProperty("storageWrite");
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
