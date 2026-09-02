import { describe, expect, it } from "vitest";
import { fetchMedia } from "../src/media-fetch.js";
import { sniffMedia } from "../src/media-sniff.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";
import type { ProviderEvent, StreamChatRequest } from "../src/providers/provider.js";
import {
  anthropicToolResultContent,
  collectToolMedia,
  MEDIA_ATTACHMENT_NOTE,
  openaiCompatibleMediaMessage,
  openaiResponsesMediaMessage,
  VIDEO_OMITTED_PLACEHOLDER,
} from "../src/providers/tool-result-media.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { injectMockStream } from "./helpers/anthropic-mock.js";

// ---- sniffMedia：魔数权威 + 扩展名仅视频兜底 ----

function withHeader(bytes: number[], tailPad = 32): Uint8Array {
  const out = new Uint8Array(Math.max(bytes.length, tailPad));
  out.set(bytes);
  return out;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

describe("sniffMedia", () => {
  it("图片魔数：PNG/JPEG/GIF/WEBP", () => {
    expect(sniffMedia(withHeader([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a]))?.mediaType).toBe("image/png");
    expect(sniffMedia(withHeader([0xff, 0xd8, 0xff, 0xe0]))?.mediaType).toBe("image/jpeg");
    expect(sniffMedia(withHeader(ascii("GIF89a")))?.mediaType).toBe("image/gif");
    expect(sniffMedia(withHeader([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))?.mediaType).toBe("image/webp");
  });

  it("视频魔数：ftyp/mp4、3gp、qt、EBML、AVI、FLV、MPEG-PS、MPEG-TS", () => {
    expect(sniffMedia(withHeader([0, 0, 0, 32, ...ascii("ftyp"), ...ascii("isom")]))?.mediaType).toBe("video/mp4");
    expect(sniffMedia(withHeader([0, 0, 0, 32, ...ascii("ftyp"), ...ascii("3gp4")]))?.mediaType).toBe("video/3gpp");
    expect(sniffMedia(withHeader([0, 0, 0, 32, ...ascii("ftyp"), ...ascii("qt  ")]))?.mediaType).toBe("video/quicktime");
    expect(sniffMedia(withHeader([0x1a, 0x45, 0xdf, 0xa3]))?.mediaType).toBe("video/webm");
    expect(sniffMedia(withHeader([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI ")]))?.mediaType).toBe("video/x-msvideo");
    expect(sniffMedia(withHeader(ascii("FLV")))?.mediaType).toBe("video/x-flv");
    expect(sniffMedia(withHeader([0x00, 0x00, 0x01, 0xba, 0x00]))?.mediaType).toBe("video/mpeg");
    const ts = new Uint8Array(400); // 188 字节定长包：3 个同步字校验
    ts[0] = 0x47; ts[188] = 0x47; ts[376] = 0x47;
    expect(sniffMedia(ts)?.mediaType).toBe("video/mp2t");
  });

  it("约束：avif/heic 图片容器按未知处理；扩展名仅兜底视频；未知返回 undefined", () => {
    expect(sniffMedia(withHeader([0, 0, 0, 32, ...ascii("ftyp"), ...ascii("avif")]))).toBeUndefined();
    expect(sniffMedia(withHeader(ascii("not media content")))).toBeUndefined();
    expect(sniffMedia(withHeader(ascii("random bytes")), "clip.mpg")?.mediaType).toBe("video/mpeg");
    expect(sniffMedia(withHeader(ascii("random bytes")), "photo.png")).toBeUndefined(); // 图片扩展名不兜底
  });

  it("扩展名与魔数冲突时信魔数", () => {
    expect(sniffMedia(withHeader([0xff, 0xd8, 0xff, 0xe0]), "clip.mpg")?.mediaType).toBe("image/jpeg");
    expect(sniffMedia(withHeader(ascii("GIF89a")), "page.html")?.mediaType).toBe("image/gif");
  });
});

// ---- tool-result-media：收集与按端点投递 ----

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUg==";
const MP4_DATA = "AAAAHGZ0eXBpc29t";

function toolMessage(toolCallId: string, content: string, media?: Array<{ type: "image" | "video"; mediaType: string; data: string }>): ChatMessage {
  return { id: `t-${toolCallId}`, role: "tool", createdAt: "2026-01-01T00:00:00.000Z", content: [{ type: "tool_result", toolCallId, content, isError: false, ...(media ? { media } : {}) }] };
}

/** 与真实持久化一致：一个 assistant 批次的全部结果落盘为**同一条** tool 消息。 */
function toolBatchMessage(results: Array<{ toolCallId: string; content: string; media?: Array<{ type: "image" | "video"; mediaType: string; data: string }> }>): ChatMessage {
  return {
    id: "t-batch", role: "tool", createdAt: "2026-01-01T00:00:00.000Z",
    content: results.map((result) => ({ type: "tool_result" as const, isError: false as const, ...result })),
  };
}

describe("collectToolMedia / provider 消息形状", () => {
  it("收集 data 内联媒体；缺 data 的块不进 集合；同 id 首次优先", () => {
    const messages = [
      toolMessage("c1", "ok", [{ type: "image", mediaType: "image/png", data: PNG_DATA }, { type: "video", mediaType: "video/mp4", data: MP4_DATA }, { type: "image", mediaType: "image/jpeg" }]),
      toolMessage("c1", "ok", [{ type: "image", mediaType: "image/png", data: "AAAA" }]),
      toolMessage("c2", "ok", []),
    ];
    const map = collectToolMedia(messages);
    expect(map.get("c1")).toEqual([
      { kind: "image", mediaType: "image/png", data: PNG_DATA },
      { kind: "video", mediaType: "video/mp4", data: MP4_DATA },
    ]);
    expect(map.has("c2")).toBe(false);
  });

  it("anthropic：无媒体原样字符串；有媒体为 [text, image…] 块数组，视频降级占位文本", () => {
    expect(anthropicToolResultContent("plain", undefined)).toBe("plain");
    const out = anthropicToolResultContent("result", [{ kind: "image", mediaType: "image/png", data: PNG_DATA }, { kind: "video", mediaType: "video/mp4", data: MP4_DATA }]);
    expect(out).toEqual([
      { type: "text", text: "result" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_DATA } },
      { type: "text", text: VIDEO_OMITTED_PLACEHOLDER },
    ]);
  });

  it("openai-compatible 合成 user 消息：image_url + video_url data URL", () => {
    const out = openaiCompatibleMediaMessage([{ kind: "image", mediaType: "image/png", data: PNG_DATA }, { kind: "video", mediaType: "video/mp4", data: MP4_DATA }]);
    expect(out).toEqual({
      role: "user",
      content: [
        { type: "text", text: MEDIA_ATTACHMENT_NOTE },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
        { type: "video_url", video_url: { url: `data:video/mp4;base64,${MP4_DATA}` } },
      ],
    });
  });

  it("openai-responses 合成 user 消息：input_image；视频降级占位文本", () => {
    const out = openaiResponsesMediaMessage([{ kind: "image", mediaType: "image/png", data: PNG_DATA }, { kind: "video", mediaType: "video/mp4", data: MP4_DATA }]);
    expect(out).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: MEDIA_ATTACHMENT_NOTE },
        { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_DATA}` },
        { type: "input_text", text: VIDEO_OMITTED_PLACEHOLDER },
      ],
    });
  });
});

// ---- provider 集成：同一 assistant 批次的多个媒体结果合并为一条合成 user 消息 ----

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return { model: "test-model", system: "system", messages: [], tools: [], signal: new AbortController().signal, ...overrides };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function captureFetch(bodies: Array<Record<string, unknown>>, payload: string) {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<void> {
  for await (const _ of iterable) { /* drain */ }
}

function mediaTurn(): ChatMessage[] {
  return [
    { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text: "看看这个" }] },
    {
      id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z",
      content: [
        { type: "tool_call", id: "c1", name: "read_media", input: { path: "a.png" } },
        { type: "tool_call", id: "c2", name: "read_media", input: { path: "b.png" } },
      ],
    },
    toolBatchMessage([
      { toolCallId: "c1", content: "[image] a.png (image/png, ~1 KB)", media: [{ type: "image", mediaType: "image/png", data: PNG_DATA }] },
      { toolCallId: "c2", content: "[image] b.png (image/png, ~1 KB)", media: [{ type: "image", mediaType: "image/png", data: PNG_DATA }] },
    ]),
  ];
}

describe("provider 集成：媒体批量投递（一条合成 user 消息）", () => {
  it("openai-compatible：tool 消息保持文本连续，批次结束后仅一条 user 消息携带两张图片", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 1 } }]) + "data: [DONE]\n\n";
    const provider = new OpenAICompatibleProvider({ baseURL: "https://example.invalid/v1", fetch: captureFetch(bodies, payload) });
    await collect(provider.streamChat(request({ messages: mediaTurn() })));
    const messages = bodies[0]?.messages as Array<Record<string, unknown>>;
    expect(messages.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    const mediaUser = messages.findLast((m) => m.role === "user") as { content: Array<Record<string, unknown>> };
    expect(mediaUser.content).toHaveLength(3);
    expect((mediaUser.content[0] as { text: string }).text).toBe(MEDIA_ATTACHMENT_NOTE);
    expect((mediaUser.content[1] as { image_url: { url: string } }).image_url.url).toBe(`data:image/png;base64,${PNG_DATA}`);
    expect((mediaUser.content[2] as { image_url: { url: string } }).image_url.url).toBe(`data:image/png;base64,${PNG_DATA}`);
  });

  it("openai-responses：function_call/function_call_output 连续，末尾一条 user 消息携带两张 input_image", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const payload = sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    const provider = new OpenAIResponsesProvider({ baseURL: "https://example.invalid/v1", fetch: captureFetch(bodies, payload), diagnosticWriter: () => undefined });
    await collect(provider.streamChat(request({ messages: mediaTurn() })));
    const input = bodies[0]?.input as Array<Record<string, unknown>>;
    const fcoIndices = input.map((item, index) => item.type === "function_call_output" ? index : -1).filter((index) => index >= 0);
    // function_call 全前置、function_call_output 全前置（既有配对修复布局），媒体 user 消息为最后一个 item
    expect(fcoIndices).toHaveLength(2);
    expect(fcoIndices[1]! - fcoIndices[0]!).toBe(1);
    const mediaUser = input.at(-1) as { content: Array<Record<string, unknown>> };
    expect(mediaUser).toMatchObject({ role: "user" });
    expect(mediaUser.content).toHaveLength(3);
    expect((mediaUser.content[1] as { image_url: string }).image_url).toBe(`data:image/png;base64,${PNG_DATA}`);
  });

  it("anthropic：媒体内联进 tool_result 的 content 块数组（每工具消息一个 user 块）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({});
    injectMockStream(provider, bodies);
    await collect(provider.streamChat(request({ messages: mediaTurn() })));
    const anthropicMessages = bodies[0]?.messages as Array<Record<string, unknown>>;
    const userMessages = anthropicMessages.filter((m) => m.role === "user").map((m) => m as { content: Array<Record<string, unknown>> });
    const toolResultBlocks = userMessages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    expect(toolResultBlocks).toHaveLength(2);
    expect(toolResultBlocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: [{ type: "text", text: expect.stringContaining("a.png") }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_DATA } }],
    });
  });
});

// ---- fetchMedia：SSRF 链 + content-type 白名单 + 魔数确认 ----

describe("fetchMedia", () => {
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  /** 测试用 DNS stub：cdn.example.com 指向公网 IPv4，避免真实 DNS 查询。 */
  const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [{ address: "93.184.216.34", family: 4 }];

  function binaryFetch(bytes: Uint8Array, contentType: string): typeof fetch {
    return (async () => new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;
  }

  it("图片 content-type + 魔数一致 → image；重定向终点扩展名兜底不影响", async () => {
    const result = await fetchMedia("https://cdn.example.com/photo", { fetchImpl: binaryFetch(pngBytes, "image/png"), lookupImpl: publicLookup });
    expect(result).toMatchObject({ kind: "image", mediaType: "image/png" });
    expect(result.bytes).toEqual(pngBytes);
  });

  it("非媒体 content-type → 报错（指引 web_fetch）", async () => {
    await expect(fetchMedia("https://cdn.example.com/page", { fetchImpl: binaryFetch(pngBytes, "text/html"), lookupImpl: publicLookup }))
      .rejects.toThrow(/Use web_fetch/);
  });

  it("content-type 是图片但魔数不符 → 拒绝", async () => {
    await expect(fetchMedia("https://cdn.example.com/photo", { fetchImpl: binaryFetch(new TextEncoder().encode("plain text"), "image/png"), lookupImpl: publicLookup }))
      .rejects.toThrow(/magic bytes/);
  });

  it("私网/回环 URL 直接拒绝（不发起请求）", async () => {
    await expect(fetchMedia("http://127.0.0.1:3210/photo", { fetchImpl: binaryFetch(pngBytes, "image/png"), lookupImpl: publicLookup })).rejects.toThrow();
    await expect(fetchMedia("http://10.0.0.5/photo", { fetchImpl: binaryFetch(pngBytes, "image/png"), lookupImpl: publicLookup })).rejects.toThrow();
  });

  it("HTTP 错误状态 → 报错", async () => {
    await expect(fetchMedia("https://cdn.example.com/missing", {
      fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
      lookupImpl: publicLookup,
    })).rejects.toThrow(/HTTP 404/);
  });
});
