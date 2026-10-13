/**
 * dsh-sync M4a 单测：附件读写 + 图片尺寸解析 + 导入图片内联升级 + owc→dsh v3 写出器。
 *
 * 四层覆盖：
 * 1. {@link imageSize} / {@link imageMediaType}：手工构造的 PNG/GIF/JPEG/WebP 头 + 垃圾输入；
 * 2. 附件助手（`writeDshAttachment` / `readDshAttachment` / `dshAttachmentObjectPath`）：往返、幂等、路径注入拒绝；
 * 3. {@link buildDshSessionEvents}：事件序列与 surfaceOp、工具生命周期重排（assistant/message 先于 tool/call）、
 *    图片附件化、标题事件、压缩导出（compaction 生命周期 + checkpoint user/message 的 seq 引用合法性）；
 * 4. {@link writeDshSession}：落盘结构 + 自家读取器回读自检 + 「目录已存在」拒绝；
 *    另含 {@link convertDshSession} 注入 resolver 后的图片内联（M3a 行为回归）。
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DSH_SYNC_WRITE_GENERATION,
  decodeDshSessionFile,
  dshAttachmentObjectPath,
  dshSessionDir,
  readDshAttachment,
  writeDshAttachment,
} from "../src/extensions/dsh-sync-dsh.js";
import { buildDshSessionEvents, validateDshEvents, writeDshSession, type DshExportBuild, type DshExportInput } from "../src/extensions/dsh-sync-export.js";
import { imageMediaType, imageSize } from "../src/extensions/dsh-sync-image-size.js";
import { convertDshSession } from "../src/extensions/dsh-sync-session.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 1×1 PNG（真实文件字节，用于校验解析器对真图也成立）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7GvHAAAAAElFTkSuQmCC",
  "base64",
);

/** 造 PNG 头（签名 + IHDR chunk，宽度/高度为 32 位大端）。 */
function pngHeader(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = Buffer.alloc(25);
  chunk.writeUInt32BE(13, 0);
  chunk.write("IHDR", 4, "latin1");
  chunk.writeUInt32BE(width, 8);
  chunk.writeUInt32BE(height, 12);
  return Buffer.concat([signature, chunk]);
}

/** 造 GIF 头（GIF89a + 逻辑屏幕描述符宽高，16 位小端）。 */
function gifHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

/** 造 JPEG 头：SOI + APP0 + SOF0（宽高在 SOF0 载荷的偏移 5/7 处）。 */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

/** 造 WebP 头（VP8X / VP8 / VP8L 三种 chunk）。 */
function webpHeader(kind: "VP8X" | "VP8 " | "VP8L", width: number, height: number): Buffer {
  const head = Buffer.alloc(30);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(22, 4);
  head.write("WEBP", 8, "latin1");
  head.write(kind, 12, "latin1");
  if (kind === "VP8X") {
    head.writeUInt32LE(10, 16);
    head.writeUIntLE(width - 1, 24, 3);
    head.writeUIntLE(height - 1, 27, 3);
    return head;
  }
  if (kind === "VP8 ") {
    head.writeUInt32LE(10, 16);
    head.writeUInt8(0x9d, 23);
    head.writeUInt8(0x01, 24);
    head.writeUInt8(0x2a, 25);
    head.writeUInt16LE(width, 26);
    head.writeUInt16LE(height, 28);
    return head;
  }
  head.writeUInt8(0x2f, 20);
  head.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return head;
}

/** 依序造 turn/step 骨架（测试用消息默认带 createdAt）。 */
function messages(): ChatMessage[] {
  return [
    { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") }] },
    {
      id: "a1",
      role: "assistant",
      createdAt: "2026-10-11T00:00:01.000Z",
      content: [{ type: "thinking", text: "想想", provider: "p" }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.txt" } }],
    },
    { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }] },
    { id: "u2", role: "user", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "text", text: "继续" }] },
    { id: "a2", role: "assistant", createdAt: "2026-10-11T00:00:04.000Z", content: [{ type: "text", text: "好的" }] },
  ];
}

/** 导出输入（dshHome/cwd 由调用方给；本函数只拼会话部分）。 */
function exportInput(dshHome: string, cwd: string, extra: Partial<DshExportInput> = {}): DshExportInput {
  return {
    dshHome,
    cwd,
    meta: { title: "冒烟会话", createdAt: "2026-10-11T00:00:00.000Z", provider: "deepseek-official", model: "deepseek-chat" },
    messages: messages(),
    ...extra,
  };
}

/** 事件类型序列。 */
function typesOf(build: DshExportBuild): string[] {
  return build.events.map((event) => String(event.type));
}

/** 压缩 checkpoint：surfaceOp 为 replace 的 `user/message`（断言 seq 引用合法性用）。 */
function checkpointEvent(build: DshExportBuild): Record<string, unknown> {
  const found = build.events.find((event) => event.type === "user/message" && event.surfaceOp !== "append");
  if (found === undefined) throw new Error("没有 replace 形态的 checkpoint user/message 事件");
  return found;
}


describe("imageSize：PNG/GIF/JPEG/WebP 尺寸解析", () => {
  it("PNG：签名 + IHDR 的 32 位大端宽高（含真实 1×1 图片）", () => {
    expect(imageSize(pngHeader(1357, 118))).toEqual({ width: 1357, height: 118 });
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });

  it("GIF：GIF87a/GIF89a 逻辑屏幕描述符的 16 位小端宽高", () => {
    expect(imageSize(gifHeader(320, 200))).toEqual({ width: 320, height: 200 });
    const legacy = gifHeader(4, 8);
    legacy.write("GIF87a", 0, "latin1");
    expect(imageSize(legacy)).toEqual({ width: 4, height: 8 });
  });

  it("JPEG：跳过 APPn 段、命中 SOF0 的宽高", () => {
    expect(imageSize(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("JPEG：只在 SOS 之后出现尺寸信息时返回 undefined", () => {
    const broken = jpegHeader(640, 480).subarray(0, 22);
    expect(imageSize(broken)).toBeUndefined();
  });

  it("WebP：VP8X / VP8 / VP8L 三种 chunk 的宽高", () => {
    expect(imageSize(webpHeader("VP8X", 800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageSize(webpHeader("VP8 ", 64, 32))).toEqual({ width: 64, height: 32 });
    expect(imageSize(webpHeader("VP8L", 17, 9))).toEqual({ width: 17, height: 9 });
  });

  it("非图片/截断/结构非法一律 undefined（不抛错）", () => {
    expect(imageSize(Buffer.alloc(0))).toBeUndefined();
    expect(imageSize(Buffer.from("这不是图片"))).toBeUndefined();
    expect(imageSize(pngHeader(10, 10).subarray(0, 20))).toBeUndefined();
    const wrongChunk = pngHeader(10, 10);
    wrongChunk.write("IDAT", 12, "latin1");
    expect(imageSize(wrongChunk)).toBeUndefined();
    expect(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x41)]))).toBeUndefined();
    expect(imageSize(webpHeader("VP8 ", 4, 4).subarray(0, 27))).toBeUndefined();
  });

  it("imageMediaType：与尺寸解析同一套魔术字节判定", () => {
    expect(imageMediaType(PNG_1X1)).toBe("image/png");
    expect(imageMediaType(gifHeader(1, 1))).toBe("image/gif");
    expect(imageMediaType(jpegHeader(1, 1))).toBe("image/jpeg");
    expect(imageMediaType(webpHeader("VP8X", 1, 1))).toBe("image/webp");
    expect(imageMediaType(Buffer.from("nope"))).toBeUndefined();
  });
});

describe("附件助手：内容寻址读写", () => {
  it("write → read 往返；attachmentId = sha256；对象路径 = objects/<前 2 位>/<全量 hex>", async () => {
    const dshHome = await tempRoot("owc-m4a-att-");
    const bytes = PNG_1X1;
    const attachmentId = writeDshAttachment(dshHome, bytes);
    expect(attachmentId).toBe(createHash("sha256").update(bytes).digest("hex"));
    const expected = path.join(dshHome, "attachments", "v1", "objects", attachmentId.slice(0, 2), attachmentId);
    expect(dshAttachmentObjectPath(dshHome, attachmentId)).toBe(expected);
    expect((await stat(expected)).size).toBe(bytes.byteLength);
    expect(readDshAttachment(dshHome, attachmentId)?.equals(bytes)).toBe(true);
    // tmp 目录不留残渣（先写 tmp 再 rename）
    expect(await readdir(path.join(dshHome, "attachments", "v1", "tmp"))).toEqual([]);
  });

  it("同一内容重复写入幂等（同 id、同内容、不报错）", async () => {
    const dshHome = await tempRoot("owc-m4a-att-");
    const first = writeDshAttachment(dshHome, PNG_1X1);
    const second = writeDshAttachment(dshHome, PNG_1X1);
    expect(second).toBe(first);
    expect(readDshAttachment(dshHome, first)?.equals(PNG_1X1)).toBe(true);
    // 另一个 dshHome 目录下是同一内容的不同副本（内容寻址，不共享目录）
    const other = await tempRoot("owc-m4a-att-");
    expect(writeDshAttachment(other, PNG_1X1)).toBe(first);
  });

  it("非法 attachmentId 全部拒绝（路径注入 / 长度 / 大小写 / 非十六进制）", async () => {
    const dshHome = await tempRoot("owc-m4a-att-");
    for (const bad of ["../etc", "..", "", "a".repeat(63), "A".repeat(64), "z".repeat(64), `${"a".repeat(63)}/`]) {
      expect(dshAttachmentObjectPath(dshHome, bad)).toBeUndefined();
      expect(readDshAttachment(dshHome, bad)).toBeUndefined();
    }
    // 合法形态但对象不存在：读不到（不抛错）
    expect(readDshAttachment(dshHome, "0".repeat(64))).toBeUndefined();
  });
});

describe("buildDshSessionEvents：事件序列与 surfaceOp", () => {
  it("user + assistant(thinking+tool_call) + tool → 稠密 seq、assistant/message 在 tool/call 之前、surface 带 append", async () => {
    const build = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd"), "session-fixed");
    expect(build.header).toEqual({
      type: "session",
      version: DSH_SYNC_WRITE_GENERATION,
      id: "session-fixed",
      createdAt: Date.parse("2026-10-11T00:00:00.000Z"),
      isSeeded: false,
      delegationDepth: 0,
      cwd: "/tmp/owc-m4a-cwd",
    });
    // dsh 关系校验要求「先广告（assistant/message 的 tool-call 块）、后启动（tool/call）」，
    // 因此 wire 投影的 tool/call → assistant/message 在导出侧被换位成 assistant/message → tool/call。
    expect(typesOf(build)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/result",
      "step/end", "turn/end",
      "turn/start", "step/start", "user/message", "assistant/message", "step/end", "turn/end",
      "session/title",
    ]);
    const advertised = build.events[3]!.data as { message: { content: Array<{ id?: string }> } };
    const started = build.events[4]!.data as { callId: string };
    expect(advertised.message.content.at(-1)!.id).toBe(started.callId);
    expect(build.events.map((event) => event.seq)).toEqual(build.events.map((_event, index) => index));
    for (const event of build.events) {
      if (["user/message", "assistant/message", "tool/result"].includes(String(event.type))) {
        expect(event.surfaceOp).toBe("append");
      } else {
        expect(event).not.toHaveProperty("surfaceOp");
      }
      expect(typeof event.time).toBe("number");
    }
    expect(build.warnings).toEqual([]);
  });

  it("一条 assistant 带两个 tool_call + 两条 tool 消息 → 广告在前、调用在后、callId 一一对应", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      meta: { title: "", createdAt: "2026-10-11T00:00:00.000Z", provider: "deepseek-official", model: "deepseek-chat" },
      messages: [
        { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "text", text: "跑两个" }] },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-10-11T00:00:01.000Z",
          content: [
            { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } },
            { type: "tool_call", id: "c2", name: "read_file", input: { path: "a.txt" } },
          ],
        },
        { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }] },
        { id: "t2", role: "tool", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "tool_result", toolCallId: "c2", content: "ok", isError: false }] },
      ],
    });
    const build = buildDshSessionEvents(input, "s");
    expect(typesOf(build)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/call",
      "tool/result", "tool/result",
      "step/end", "turn/end",
    ]);
    const calls = build.events.filter((event) => event.type === "tool/call").map((event) => (event.data as { callId: string }).callId);
    expect(calls).toEqual(["c1", "c2"]);
    // name/arguments 必须与广告块逐字一致（dsh 的 tool/call 匹配校验）
    const blocks = (build.events[3]!.data as { message: { content: Array<{ type: string; id: string; name: string; arguments: string }> } }).message.content;
    expect(blocks.map((block) => [block.id, block.name, block.arguments])).toEqual([
      ["c1", "bash", JSON.stringify({ cmd: "ls" })],
      ["c2", "read_file", JSON.stringify({ path: "a.txt" })],
    ]);
    expect(build.warnings).toEqual([]);
  });

  it("时间取自消息 createdAt（毫秒）", async () => {
    const build = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd"), "session-fixed");
    expect(build.events[0]!.time).toBe(Date.parse("2026-10-11T00:00:00.000Z"));
    expect(build.events[11]!.time).toBe(Date.parse("2026-10-11T00:00:04.000Z"));
  });

  it("title → session/title 事件（source.kind=fallback，messageSeqs 引用更早的 user/message）", async () => {
    const build = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd"), "session-fixed");
    const titleEvent = build.events.find((event) => event.type === "session/title");
    expect(titleEvent).toMatchObject({ data: { title: "冒烟会话", messageSeqs: [2], source: { kind: "fallback" } } });
    expect(build.events[2]!.type).toBe("user/message");
    expect((titleEvent!.data as { messageSeqs: number[] }).messageSeqs[0]!).toBeLessThan(titleEvent!.seq as number);
  });

  it("没有用户消息时不编造标题（记 warning）", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: [{ id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "text", text: "只在" }] }],
    });
    const build = buildDshSessionEvents(input, "session-fixed");
    expect(typesOf(build)).not.toContain("session/title");
    expect(build.warnings.some((warning) => warning.includes("没有用户消息"))).toBe(true);
  });

  it("缺省 provider/model → 空归属 + warning；显式给出则不告警", async () => {
    const home = await tempRoot("owc-m4a-");
    const without = buildDshSessionEvents(exportInput(home, "/tmp/owc-m4a-cwd", { meta: { title: "t", createdAt: "2026-10-11T00:00:00.000Z" } }), "s");
    expect(without.warnings.some((warning) => warning.includes("meta.provider/model"))).toBe(true);
    const withAttribution = buildDshSessionEvents(exportInput(home, "/tmp/owc-m4a-cwd"), "s");
    const assistant = withAttribution.events.find((event) => event.type === "assistant/message");
    expect((assistant!.data as { message: { source: unknown } }).message.source).toEqual({
      kind: "model",
      provider: "deepseek-official",
      model: "deepseek-chat",
    });
    expect(withAttribution.warnings).toEqual([]);
  });

  it("cwd 非绝对路径直接抛错", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "relative/cwd");
    expect(() => buildDshSessionEvents(input, "s")).toThrow(/cwd 必须是绝对路径/);
  });
});

describe("buildDshSessionEvents：图片附件化", () => {
  it("内联 base64 → 内容寻址附件块 + attachmentWrites 收集（dsh attachment 字段齐备）", async () => {
    const build = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd"), "session-fixed");
    const attachmentId = createHash("sha256").update(PNG_1X1).digest("hex");
    expect(build.attachmentWrites).toHaveLength(1);
    expect(build.attachmentWrites[0]!.bytes.equals(PNG_1X1)).toBe(true);
    expect(build.attachmentWrites[0]!.block).toEqual({
      type: "image",
      attachment: { attachmentId, mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 },
    });
    const userEvent = build.events.find((event) => event.type === "user/message");
    expect((userEvent!.data as { content: unknown[] }).content[1]).toEqual(build.attachmentWrites[0]!.block);
    // 附件块键集与上游校验一致（恰为 type + attachment；无 offloaded 这类新增字段）
    expect(Object.keys(build.attachmentWrites[0]!.block)).toEqual(["type", "attachment"]);
  });

  it("同一图片出现在两个消息里 → 两个块、两条写入（内容相同由写入器去重）", async () => {
    const shared = PNG_1X1.toString("base64");
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: [
        { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "image", mediaType: "image/png", data: shared }] },
        { id: "u2", role: "user", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "image", mediaType: "image/png", data: shared }] },
      ],
    });
    const build = buildDshSessionEvents(input, "s");
    expect(build.attachmentWrites).toHaveLength(2);
    const ids = build.attachmentWrites.map((write) => (write.block.attachment as { attachmentId: string }).attachmentId);
    expect(new Set(ids).size).toBe(1);
  });

  it("ref 形态（无 data）→ 占位文本 + warning", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: [{ id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "image", mediaType: "image/png", ref: "uploads/a.png" }] }],
    });
    const build = buildDshSessionEvents(input, "s");
    expect(build.attachmentWrites).toEqual([]);
    const userEvent = build.events.find((event) => event.type === "user/message");
    expect((userEvent!.data as { content: unknown[] }).content).toEqual([{ type: "text", text: "[owc 图片]" }]);
    expect(build.warnings.some((warning) => warning.includes("仅有落盘引用"))).toBe(true);
  });

  it("字节无法解析（空/非图片）→ 占位文本 + warning", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: [
        { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "image", mediaType: "image/png", data: Buffer.from("not-webp").toString("base64") }] },
      ],
    });
    const build = buildDshSessionEvents(input, "s");
    expect(build.attachmentWrites).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("字节无法解析"))).toBe(true);
  });

  /** 一条工具链（assistant 广告 + tool 结果带 media[]），用于 media 导出用例。 */
  function mediaMessages(media: unknown[], where = "见图"): ChatMessage[] {
    return [
      { id: "u1", role: "user", createdAt: "2026-10-10T23:59:59.000Z", content: [{ type: "text", text: "看这张图" }] },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-10-11T00:00:00.000Z",
        content: [{ type: "tool_call", id: "c1", name: "read_media", input: {} }],
      },
      {
        id: "t1",
        role: "tool",
        createdAt: "2026-10-11T00:00:01.000Z",
        content: [{ type: "tool_result", toolCallId: "c1", content: where, isError: false, media }],
      },
    ] as ChatMessage[];
  }

  it("tool_result.media[] 的图片 → 补进包装块 content 的 image{attachment}（既有投影不产出该块）", async () => {
    // 既有投影 `session-events.ts::toDshBlocks` 的 tool_result 分支只取 `content` 文本、不投影 media，
    // 因此导出侧自己在包装块的 content 尾部补 image 块（dsh v3 的 tool-result 子块允许 image）。
    // （工具结果必须有先行广告的 tool_call，否则会被导出前的孤儿结果清洗丢掉——见下方「正确性门」用例。）
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: mediaMessages([{ type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") }]),
    });
    const build = buildDshSessionEvents(input, "s");
    expect(build.attachmentWrites).toHaveLength(1);
    const expectedId = createHash("sha256").update(PNG_1X1).digest("hex");
    expect(build.attachmentWrites[0]!.bytes.equals(PNG_1X1)).toBe(true);
    const toolEvent = build.events.find((event) => event.type === "tool/result");
    const content = (toolEvent!.data as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content[0]).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      content: [
        { type: "text", text: "见图" },
        {
          type: "image",
          attachment: { attachmentId: expectedId, mediaType: "image/png", bytes: PNG_1X1.byteLength, width: 1, height: 1 },
        },
      ],
    });
    expect(build.warnings).toEqual([]);
  });

  it("tool_result.media[] 不可读（ref 未内联 / 非图片）与视频：记警告且不补块", async () => {
    const refOnly = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: mediaMessages([{ type: "image", mediaType: "image/png", ref: "uploads/a.png" }]),
    }), "s");
    expect(refOnly.attachmentWrites).toEqual([]);
    expect(refOnly.warnings.some((warning) => warning.includes("tool_result.media[]") && warning.includes("仅有落盘引用"))).toBe(true);

    const withVideo = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: mediaMessages([
        { type: "video", mediaType: "video/mp4", data: "AAAA" },
        { type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") },
      ]),
    }), "s");
    // 视频只告警跳过，图片照常补入（顺序按 media 原序过滤掉视频）
    expect(withVideo.warnings.some((warning) => warning.includes("是视频（video/mp4）"))).toBe(true);
    const toolEvent = withVideo.events.find((event) => event.type === "tool/result");
    const content = (toolEvent!.data as { message: { content: Array<{ content: Array<Record<string, unknown>> }> } }).message.content;
    expect(content[0]!.content.map((block) => block.type)).toEqual(["text", "image"]);
  });
});

describe("buildDshSessionEvents：assistant 回放元数据（thinking signature/redacted → source.replayState）", () => {
  /** 一条 assistant 消息（thinking + text + tool_call）+ 其工具结果，构成可导出的完整工具链。 */
  function replayMessages(thinking: { text: string; provider: string; signature?: string; redacted?: string }, textExtra: Record<string, unknown> = {}): ChatMessage[] {
    return [
      { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "text", text: "问" }] },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-10-11T00:00:01.000Z",
        content: [
          { type: "thinking", ...thinking },
          { type: "text", text: "答", ...textExtra },
          { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" }, itemId: "fc_1" },
        ],
      },
      { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }] },
    ] as ChatMessage[];
  }

  /** 取导出流里第一条 assistant/message 的 source（replayState 落点）。 */
  function sourceOf(build: DshExportBuild): Record<string, unknown> {
    const event = build.events.find((item) => item.type === "assistant/message");
    return (event!.data as { message: { source: Record<string, unknown> } }).message.source;
  }

  it("anthropic-messages：按位写 replayState（text/reasoning+signature/reasoning+redacted/tool-call），零警告", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "anthropic-messages" },
      messages: replayMessages({ text: "想", provider: "deepseek-official", signature: "sig-1" }),
    });
    const build = buildDshSessionEvents(input, "s");
    expect(sourceOf(build).replayState).toEqual({
      response: { kind: "llm-service-lite-anthropic", version: 1 },
      blocks: [{ type: "reasoning", signature: "sig-1" }, { type: "text" }, { type: "tool-call" }],
    });
    expect(build.warnings).toEqual([]);

    // redacted（无 text 的密文块）同样按位写回
    const redacted = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "anthropic-messages" },
      messages: replayMessages({ text: "", provider: "deepseek-official", redacted: "cipher-1" }),
    }), "s");
    expect((sourceOf(redacted).replayState as { blocks: unknown[] }).blocks[0]).toEqual({ type: "reasoning", redacted: "cipher-1" });
  });

  it("openai-responses：reasoning item 取 thinking.signature；text/tool-call 带 itemId", async () => {
    const input = exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "openai-responses" },
      messages: replayMessages(
        { text: "想", provider: "deepseek-official", signature: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "xx" }) },
        { textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "final" }) },
      ),
    });
    const build = buildDshSessionEvents(input, "s");
    expect(sourceOf(build).replayState).toEqual({
      response: { kind: "llm-service-lite-responses", version: 1 },
      blocks: [
        { type: "reasoning", item: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "xx" }) },
        { type: "text", itemId: "msg_1" },
        { type: "tool-call", itemId: "fc_1" },
      ],
    });
    expect(build.warnings).toEqual([]);
  });

  it("openai-chat-completions / 无接口信息：不写 replayState 且逐条告警（不静默丢签名）", async () => {
    const chat = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "openai-chat-completions" },
      messages: replayMessages({ text: "想", provider: "deepseek-official", signature: "sig-1", redacted: "cipher-1" }),
    }), "s");
    expect(sourceOf(chat).replayState).toBeUndefined();
    expect(chat.warnings.some((warning) => warning.includes("signature、redacted") && warning.includes("openai-chat-completions"))).toBe(true);

    const unknown = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      messages: replayMessages({ text: "想", provider: "deepseek-official", signature: "sig-1" }),
    }), "s");
    expect(sourceOf(unknown).replayState).toBeUndefined();
    expect(unknown.warnings.some((warning) => warning.includes("signature") && warning.includes("未知"))).toBe(true);
  });

  it("消息里含 image 块（replay 词表没有对应项）→ 放弃回放并告警；无签名时不写也不告警", async () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", createdAt: "2026-10-11T00:00:00.000Z", content: [{ type: "text", text: "问" }] },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-10-11T00:00:01.000Z",
        content: [
          { type: "thinking", text: "想", provider: "p", signature: "sig-1" },
          { type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") },
        ],
      },
    ];
    const build = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "anthropic-messages" },
      messages,
    }), "s");
    expect(sourceOf(build).replayState).toBeUndefined();
    expect(build.warnings.some((warning) => warning.includes("无法按位对齐"))).toBe(true);

    const plain = buildDshSessionEvents(exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      providerInterfaces: { "deepseek-official": "anthropic-messages" },
      messages: replayMessages({ text: "想", provider: "p" }),
    }), "s");
    expect(sourceOf(plain).replayState).toBeUndefined();
    expect(plain.warnings).toEqual([]);
  });
});

describe("buildDshSessionEvents：压缩导出", () => {
  /** 带压缩记录的输入（压缩前 3 条消息：u1/a1/t1）。 */
  async function compactionInput(): Promise<DshExportInput> {
    return exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
      ledger: { compacted: { uptoIndex: 3, uptoMessageId: "t1", summary: "之前读了 a.txt", createdAt: "2026-10-11T00:00:05.000Z" } },
    });
  }

  it("compaction 生命周期：start → summary → checkpoint(user/message replace) → end；shadowedSeqs = 当前 surface 前缀 span", async () => {
    const build = buildDshSessionEvents(await compactionInput(), "session-fixed");
    const types = typesOf(build);
    expect(types.slice(-4)).toEqual(["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
    // 整段必须落在末轮 turn/end 之后、无 open turn（dsh 的 compaction/start 校验要求 turn 为 null）
    expect(types.lastIndexOf("turn/end")).toBeLessThan(types.indexOf("compaction/start"));

    // 当前 surface = user/message(2) + assistant/message(3) + tool/result(5) + user/message(10) + assistant/message(11)
    const summary = build.events[build.events.length - 3]!;
    expect(summary.data).toEqual({
      compactionId: "owc-compaction-session-fixed",
      summary: [{ type: "text", text: "之前读了 a.txt" }],
      // 被压缩前缀 span：start = 首个 surface seq(2)、end = 锚点消息 t1 的最后一条 surface 事件(5)
      shadowedRange: { start: 2, end: 5 },
      shadowedSeqs: [2, 3, 5],
      shadowedTokenCount: 0,
      provider: "deepseek-official",
      model: "deepseek-chat",
    });
    expect(summary.time).toBe(Date.parse("2026-10-11T00:00:05.000Z"));
    expect(build.events[build.events.length - 4]!.data).toEqual({ compactionId: "owc-compaction-session-fixed", turn: null });
    expect(build.events[build.events.length - 1]!.data).toEqual({ compactionId: "owc-compaction-session-fixed", turn: null });

    const checkpoint = checkpointEvent(build);
    expect(checkpoint.type).toBe("user/message");
    expect(checkpoint.surfaceOp).toEqual({ op: "replace", startSeq: 2, endSeq: 5 });
    // replace 端点必须严格早于本事件；sourceEventSeqs 非空、去重、且都更早，并覆盖被替换 span 的全部 surface seq
    for (const seq of [2, 5]) expect(seq).toBeLessThan(checkpoint.seq as number);
    const sources = checkpoint.sourceEventSeqs as number[];
    expect(sources).toEqual([2, 3, 5]);
    expect(new Set(sources).size).toBe(sources.length);
    for (const seq of sources) expect(seq).toBeLessThan(checkpoint.seq as number);
    // checkpoint 是 user/message（不是 system/message），source 恰为 plugin=compact + compactionId
    expect(checkpoint.data).toEqual({
      id: "owc-compaction-session-fixed",
      role: "user",
      content: [{ type: "text", text: "之前读了 a.txt" }],
      source: { kind: "plugin", plugin: "compact", compactionId: "owc-compaction-session-fixed" },
    });
    expect(types).not.toContain("system/message");
    expect(build.warnings).toEqual([]);
  });

  it("锚点缺失（uptoMessageId 不在消息列表）→ 放弃压缩导出 + warning", async () => {
    const input = await compactionInput();
    input.ledger = { compacted: { uptoIndex: 3, uptoMessageId: "不存在", summary: "s" } };
    const build = buildDshSessionEvents(input, "s");
    expect(typesOf(build)).not.toContain("compaction/summary");
    expect(typesOf(build)).not.toContain("compaction/start");
    expect(build.warnings.some((warning) => warning.includes("压缩锚点消息 不存在"))).toBe(true);
  });

  it("无 uptoMessageId 时按 uptoIndex-1 回退；越界则放弃", async () => {
    const input = await compactionInput();
    input.ledger = { compacted: { uptoIndex: 2, summary: "只有一轮" } };
    const build = buildDshSessionEvents(input, "s");
    const summary = build.events[build.events.length - 3]!;
    // uptoIndex=2 → 锚点 = a1（下标 1），其最后一条 **surface** 事件 = assistant/message(seq 3)；
    // span 起点仍是首个 surface seq(2)，故 shadowedSeqs = [2, 3]。
    expect((summary.data as { shadowedRange: unknown }).shadowedRange).toEqual({ start: 2, end: 3 });
    expect((summary.data as { shadowedSeqs: unknown }).shadowedSeqs).toEqual([2, 3]);
    const outOfRange = await compactionInput();
    outOfRange.ledger = { compacted: { uptoIndex: 99, summary: "越界" } };
    const skipped = buildDshSessionEvents(outOfRange, "s");
    expect(typesOf(skipped)).not.toContain("compaction/summary");
    expect(skipped.warnings.some((warning) => warning.includes("超出消息范围"))).toBe(true);
  });

  it("导出流不含 system/message（受保护 system head 守卫因此不可达，仅作防御）", async () => {
    // dsh 的 replace 区间不得遮蔽受保护的 system head，且 surface replace 也不得碰到它。
    // 既有投影与本导出器都不产生 system/message，导出流恒以 turn/start 开头，
    // 因此该守卫在当前实现下不可触发；这里锁定该前提（换成 checkpoint user/message 之后依然成立）。
    const build = buildDshSessionEvents(await compactionInput(), "session-fixed");
    expect(build.events[0]!.type).toBe("turn/start");
    expect(typesOf(build)).not.toContain("system/message");
  });

  it("缺省 provider/model → summary 的归属字段填 unknown 占位 + warning", async () => {
    const build = buildDshSessionEvents(
      exportInput(await tempRoot("owc-m4a-"), "/tmp/owc-m4a-cwd", {
        meta: { title: "冒烟会话", createdAt: "2026-10-11T00:00:00.000Z" },
        ledger: { compacted: { uptoIndex: 3, uptoMessageId: "t1", summary: "之前读了 a.txt" } },
      }),
      "session-fixed",
    );
    const summary = build.events.find((event) => event.type === "compaction/summary");
    expect(summary!.data).toMatchObject({ provider: "unknown", model: "unknown" });
    expect(build.warnings.some((warning) => warning.includes("占位"))).toBe(true);
  });
});

describe("writeDshSession：落盘 + 回读自检 + 只新增", () => {
  it("写入 → decodeDshSessionFile 回读一致；目录结构 --<slug>--/<id>/session.v3.jsonl.zstd", async () => {
    const dshHome = await tempRoot("owc-m4a-home-");
    const cwd = await tempRoot("owc-m4a-cwd-");
    const input = exportInput(dshHome, cwd);
    const result = await writeDshSession(input);

    expect(result.dir).toBe(dshSessionDir(dshHome, cwd, result.sessionId));
    const segments = path.relative(dshHome, result.dir).split(path.sep);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("sessions");
    expect(segments[1]!.startsWith("--") && segments[1]!.endsWith("--")).toBe(true);
    expect(segments[2]).toBe(result.sessionId);
    expect(path.basename(result.file)).toBe(`session.v${DSH_SYNC_WRITE_GENERATION}.jsonl.zstd`);
    expect(result.eventCount).toBe(15);
    expect(result.attachments).toBe(1);
    expect(result.warnings).toEqual([]);

    const decoded = await decodeDshSessionFile({
      file: result.file,
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    expect(decoded.header.id).toBe(result.sessionId);
    expect(decoded.header.version).toBe(DSH_SYNC_WRITE_GENERATION);
    expect(decoded.header.cwd).toBe(cwd);
    expect(decoded.header.createdAt).toBe(Date.parse("2026-10-11T00:00:00.000Z"));
    expect(decoded.header.isSeeded).toBe(false);
    expect(decoded.events).toHaveLength(result.eventCount);
    expect(decoded.events.map((event) => event.seq)).toEqual(decoded.events.map((_event, index) => index));

    // 附件落盘在内容寻址对象目录里，字节与 owc 图片一致
    const attachmentId = createHash("sha256").update(PNG_1X1).digest("hex");
    expect((await stat(path.join(dshHome, "attachments", "v1", "objects", attachmentId.slice(0, 2), attachmentId))).size).toBe(PNG_1X1.byteLength);
    expect((await readDshAttachment(dshHome, attachmentId))?.equals(PNG_1X1)).toBe(true);
    // 目录里只有会话文件（没有半成品 tmp）
    expect(await readdir(result.dir)).toEqual([`session.v${DSH_SYNC_WRITE_GENERATION}.jsonl.zstd`]);
  });

  it("同一 sessionId 二次调用 → 抛「会话目录已存在」（不覆盖已有会话）", async () => {
    const dshHome = await tempRoot("owc-m4a-home-");
    const cwd = await tempRoot("owc-m4a-cwd-");
    const input = exportInput(dshHome, cwd);
    const first = await writeDshSession(input, "session-fixed");
    expect(first.sessionId).toBe("session-fixed");
    const before = await readFile(first.file);
    await expect(writeDshSession(input, "session-fixed")).rejects.toThrow(/会话目录已存在/);
    // 原文件未被触碰
    expect((await readFile(first.file)).equals(before)).toBe(true);
  });

  it("缺省 sessionId 每次生成新 id（只新增语义：两次导出两个目录）", async () => {
    const dshHome = await tempRoot("owc-m4a-home-");
    const cwd = await tempRoot("owc-m4a-cwd-");
    const input = exportInput(dshHome, cwd);
    const first = await writeDshSession(input);
    const second = await writeDshSession(input);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.dir).not.toBe(first.dir);
  });

  it("压缩导出同样可被自家读取器回读（含 checkpoint user/message 的 replace）", async () => {
    const dshHome = await tempRoot("owc-m4a-home-");
    const cwd = await tempRoot("owc-m4a-cwd-");
    const input = exportInput(dshHome, cwd, {
      ledger: { compacted: { uptoIndex: 3, uptoMessageId: "t1", summary: "之前读了 a.txt" } },
    });
    const result = await writeDshSession(input, "session-compacted");
    const decoded = await decodeDshSessionFile({
      file: result.file,
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    expect(decoded.events).toHaveLength(result.eventCount);
    expect(decoded.events.map((event) => String(event.type)).slice(-4)).toEqual([
      "compaction/start", "compaction/summary", "user/message", "compaction/end",
    ]);
    expect(decoded.events.map((event) => event.seq)).toEqual(decoded.events.map((_event, index) => index));
  });
});

describe("convertDshSession：resolver 注入后的图片内联（M4a）", () => {
  /** 一条用户消息（图片）+ 一条 tool_result（内含图片）的最小事件流。 */
  function events(): Array<Record<string, unknown>> {
    return [
      { type: "turn/start", seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
      { type: "step/start", seq: 1, time: 1_700_000_000_000, data: { turn: 1, step: 1 } },
      {
        type: "user/message",
        seq: 2,
        time: 1_700_000_000_000,
        surfaceOp: "append",
        data: {
          id: "u1",
          role: "user",
          source: { kind: "user" },
          content: [
            { type: "text", text: "看图" },
            { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 3 } },
          ],
        },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: 1_700_000_000_001,
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: {
            id: "a1",
            role: "assistant",
            source: { kind: "model", provider: "p", model: "m" },
            content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }],
          },
        },
      },
      {
        type: "tool/result",
        seq: 4,
        time: 1_700_000_000_002,
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "t1",
            role: "tool",
            toolCallId: "c1",
            source: { kind: "tool", callId: "c1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [
                  { type: "text", text: "图：" },
                  { type: "image", attachment: { attachmentId: "att-2", mediaType: "image/jpeg", bytes: 9 } },
                ],
              },
            ],
          },
        },
      },
    ];
  }

  /** 头行（v3）。 */
  const header = { type: "session", version: 3, id: "dsh-1", createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0 };

  it("命中 resolver → image 块内联（用户消息）；tool_result 内图片进 media[]", () => {
    const resolved: string[] = [];
    const conversion = convertDshSession(header, events(), {
      resolveAttachment: (attachmentId) => {
        resolved.push(attachmentId);
        if (attachmentId === "att-1") return { mediaType: "image/png", data: PNG_1X1.toString("base64") };
        if (attachmentId === "att-2") return { mediaType: "image/jpeg", data: "AAAA" };
        return undefined;
      },
    });
    expect(resolved).toEqual(["att-1", "att-2"]);
    expect(conversion.messages[0]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") },
    ]);
    expect(conversion.messages[2]!.content).toEqual([
      {
        type: "tool_result",
        toolCallId: "c1",
        content: "图：",
        isError: false,
        media: [{ type: "image", mediaType: "image/jpeg", data: "AAAA" }],
      },
    ]);
    expect(conversion.report.counts).toEqual({ user: 1, assistant: 1, tool: 1, images: 2, imagesMissing: 0 });
    expect(conversion.report.warnings.some((warning) => warning.includes("图片附件"))).toBe(false);
  });

  it("未命中 → 维持 M3a 占位行为（计数 + 警告措辞按是否注入 resolver 区分）", () => {
    const miss = convertDshSession(header, events(), { resolveAttachment: () => undefined });
    expect(miss.messages[0]!.content).toEqual([
      { type: "text", text: "看图" },
      { type: "text", text: "[dsh 图片附件 att-1]" },
    ]);
    expect(miss.messages[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "c1", content: "图：\n[dsh 图片附件 att-2]", isError: false },
    ]);
    expect(miss.report.counts).toMatchObject({ images: 2, imagesMissing: 2 });
    expect(miss.report.warnings.some((warning) => warning.includes("未命中 resolver"))).toBe(true);

    const noResolver = convertDshSession(header, events());
    expect(noResolver.messages[0]!.content[1]).toEqual({ type: "text", text: "[dsh 图片附件 att-1]" });
    expect(noResolver.report.counts).toMatchObject({ images: 2, imagesMissing: 2 });
    expect(noResolver.report.warnings.some((warning) => warning.includes("图片附件本里程碑只做文本占位"))).toBe(true);
  });

  it("resolver 返回空 mediaType/data → 视为未命中（不产出非法 image 块）", () => {
    const conversion = convertDshSession(header, events(), {
      resolveAttachment: () => ({ mediaType: "", data: "" }),
    });
    expect(conversion.messages[0]!.content[1]).toEqual({ type: "text", text: "[dsh 图片附件 att-1]" });
    expect(conversion.report.counts).toMatchObject({ images: 2, imagesMissing: 2 });
  });

  it("resolver + readDshAttachment 串起来即 host 侧内联路径（附件字节 → base64）", async () => {
    const dshHome = await tempRoot("owc-m4a-att-");
    const attachmentId = writeDshAttachment(dshHome, PNG_1X1);
    // 把事件里的 attachmentId 换成真实写入的 sha256（模拟 dsh 会话里真实存在的附件引用）
    const withRealId = events();
    for (const event of withRealId) {
      const data = event.data as { content?: unknown[]; message?: { content?: unknown[] } };
      const blocks = [data.content, data.message?.content].flatMap((list) => list ?? []);
      for (const raw of blocks) {
        const block = raw as { type?: string; attachment?: { attachmentId?: string }; content?: unknown[] };
        if (block.type === "image" && block.attachment !== undefined) block.attachment.attachmentId = attachmentId;
        for (const nested of block.content ?? []) {
          const inner = nested as { type?: string; attachment?: { attachmentId?: string } };
          if (inner.type === "image" && inner.attachment !== undefined) inner.attachment.attachmentId = attachmentId;
        }
      }
    }
    const conversion = convertDshSession(header, withRealId, {
      resolveAttachment: (id) => {
        const bytes = readDshAttachment(dshHome, id);
        return bytes === undefined ? undefined : { mediaType: "image/png", data: bytes.toString("base64") };
      },
    });
    expect(conversion.report.counts).toEqual({ user: 1, assistant: 1, tool: 1, images: 2, imagesMissing: 0 });
    expect(conversion.messages[0]!.content[1]).toEqual({ type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") });
    // tool_result 内的图片进 media[]
    expect(conversion.messages[2]!.content[0]).toMatchObject({
      type: "tool_result",
      media: [{ type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") }],
    });
  });
});

/**
 * 导出方向的正确性门（代码审查 P1-4）：消息层清洗（{@link preprocessExportMessages} 的行为）、
 * 事件层修复（首条非 user 补 start、未结算工具调用补 dsh 官方 TOOL_NOT_STARTED 修复事件）、
 * 写盘前结构校验（{@link validateDshEvents}）。
 *
 * 复现的坏输入（都会让 dsh 拒收整份会话）：孤儿 tool_result、一条 tool 消息多结果、
 * assistant 广告了 tool_call 却没有结果、消息列表首条不是 user。
 */
describe("导出方向的正确性门（P1-4：消息清洗 + 事件修复 + 写盘前校验）", () => {
  /** 构造导出输入（不落盘，dshHome/cwd 只是路径字符串）。 */
  function inputWith(messages: ChatMessage[], extra: Partial<DshExportInput> = {}): DshExportInput {
    return {
      dshHome: "/tmp/owc-p14-home",
      cwd: "/tmp/owc-p14-cwd",
      meta: { provider: "demo", model: "demo-model" },
      messages,
      ...extra,
    };
  }

  /** 事件时间（ISO → 毫秒，与投影口径一致）。 */
  function timeOfIso(iso: string): number {
    return Date.parse(iso);
  }

  it("孤儿 tool_result（无先行广告，如 !cmd 直写路径）→ 丢块；块丢光则整条消息丢弃并告警", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "!ls" }] },
      { id: "t-orphan", role: "tool", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_result", toolCallId: "nope", content: "x", isError: false }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } }] },
      { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }] },
    ]), "p14-orphan");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("t-orphan") && warning.includes("孤儿结果"))).toBe(true);
    expect(build.warnings.some((warning) => warning.includes("t-orphan") && warning.includes("整条消息不再导出"))).toBe(true);
    const results = build.events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(1);
    expect((results[0]!.data as { message: { source: { callId: string } } }).message.source.callId).toBe("c1");
    // 孤儿消息整条没了：没有任何事件引用 nope
    expect(JSON.stringify(build.events)).not.toContain("nope");
  });

  it("同一条 tool 消息里孤儿与合法结果并存 → 只丢孤儿块，保留原消息 id", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑一下" }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } }] },
      {
        id: "t-mixed",
        role: "tool",
        createdAt: "2026-10-11T00:00:02.000Z",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "ok", isError: false },
          { type: "tool_result", toolCallId: "ghost", content: "x", isError: false },
        ],
      },
    ]), "p14-mixed");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.filter((warning) => warning.includes("孤儿结果"))).toHaveLength(1);
    const results = build.events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(1);
    expect((results[0]!.data as { message: { id: string } }).message.id).toBe("t-mixed");
  });

  it("一条 tool 消息含 2 个 tool_result 块 → 拆成 2 条单块消息（id 派生 <原id>-<i>）", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "并行两个" }] },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-10-11T00:00:01.000Z",
        content: [
          { type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } },
          { type: "tool_call", id: "c2", name: "bash", input: { cmd: "b" } },
        ],
      },
      {
        id: "t-both",
        role: "tool",
        createdAt: "2026-10-11T00:00:02.000Z",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "a-ok", isError: false },
          { type: "tool_result", toolCallId: "c2", content: "b-ok", isError: false },
        ],
      },
    ]), "p14-split");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("t-both") && warning.includes("已拆成 2 条单块消息"))).toBe(true);
    const results = build.events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(2);
    // 相对顺序保持；id 各派生 <原id>-<i>，每条都恰好一个包装块
    expect(results.map((event) => {
      const data = event.data as { message: { id: string; source: { callId: string }; content: Array<{ type: string; toolCallId: string }> } };
      return [data.message.id, data.message.source.callId, data.message.content.length, data.message.content[0]!.toolCallId];
    })).toEqual([["t-both-0", "c1", 1, "c1"], ["t-both-1", "c2", 1, "c2"]]);
  });

  it("assistant 有 tool_call 但无 tool_result（回合中断）→ 补官方 TOOL_NOT_STARTED 修复事件（逐字段 + id 后缀 = 最终 seq）", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const assistantTime = "2026-10-11T00:00:01.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "两个工具都中断了" }] },
      {
        id: "a1",
        role: "assistant",
        createdAt: assistantTime,
        content: [
          { type: "text", text: "开始" },
          { type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } },
          { type: "tool_call", id: "c2", name: "read_file", input: { path: "b" } },
        ],
      },
    ]), "p14-interrupted");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(typesOf(build)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/call",
      "tool/result", "tool/result",
      "step/end", "turn/end",
    ]);
    // 修复事件逐字段（与上游 isExactToolNotStartedRepair / isRepairIdentity 精确对齐）
    expect(build.events[6]).toEqual({
      type: "tool/result",
      seq: 6,
      time: timeOfIso(assistantTime),
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "interrupted-tool-result-c1-6",
          role: "user",
          source: { kind: "tool", callId: "c1" },
          content: [{
            type: "tool-result",
            toolCallId: "c1",
            isError: true,
            content: [{ type: "text", text: "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed." }],
          }],
        },
        error: { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" },
      },
    });
    // 第二条修复的 id 必须用**自己的**最终 seq（先插入占位、重编号后回填）
    expect((build.events[7]!.data as { message: { id: string } }).message.id).toBe("interrupted-tool-result-c2-7");
    expect(build.warnings.filter((warning) => warning.includes("工具未启动")).length).toBe(2);
  });

  it("首条不是 user（外部导入的任意 JSONL）→ 补 turn/start{turn:1} + step/start{turn:1,step:1}", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "a1", role: "assistant", createdAt: base, content: [{ type: "text", text: "历史被截断" }] },
      { id: "u1", role: "user", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "text", text: "继续" }] },
    ]), "p14-head");

    expect(typesOf(build)).toEqual([
      "turn/start", "step/start", "assistant/message",
      "step/end", "turn/end",
      "turn/start", "step/start", "user/message",
      "step/end", "turn/end",
    ]);
    expect(build.events[0]!.data).toEqual({ turn: 1 });
    expect(build.events[1]!.data).toEqual({ turn: 1, step: 1 });
    // 补的编号与投影的隐式 turn/step（首条 assistant 得到 turn 1 step 1）一致
    expect((build.events[2]!.data as { turn: number; step: number })).toMatchObject({ turn: 1, step: 1 });
    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("首条消息不是用户消息"))).toBe(true);
  });

  it("合规流（含压缩导出）零违规：校验器不是空架子", async () => {
    const build = buildDshSessionEvents(exportInput("/tmp/owc-p14-ok", "/tmp/owc-p14-ok-cwd", {
      ledger: { compacted: { uptoIndex: 3, uptoMessageId: "t1", summary: "摘要" } },
    }), "p14-ok");
    expect(validateDshEvents(build.events)).toEqual([]);
  });

  it("validateDshEvents 拦截构造的坏流（逐类）", () => {
    const base = "2026-10-11T00:00:00.000Z";
    /** 手工事件（seq 由下标给出）。 */
    const manual = (index: number, type: string, data: unknown, surfaceOp?: string): Record<string, unknown> => ({
      type, seq: index, time: timeOfIso(base) + index, data, ...(surfaceOp === undefined ? {} : { surfaceOp }),
    });
    /** 一条合法的手工流（turn 1：user → assistant 广告 + tool/call + tool/result）。 */
    const good = (): Array<Record<string, unknown>> => [
      manual(0, "turn/start", { turn: 1 }),
      manual(1, "step/start", { turn: 1, step: 1 }),
      manual(2, "user/message", { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }, "append"),
      manual(3, "assistant/message", {
        turn: 1, step: 1, stream: [],
        message: { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
      }, "append"),
      manual(4, "tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }),
      manual(5, "tool/result", {
        turn: 1, step: 1,
        message: { id: "t1", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }] },
      }, "append"),
      manual(6, "step/end", { turn: 1, step: 1 }),
      manual(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    expect(validateDshEvents(good())).toEqual([]);

    const clone = (): Array<Record<string, unknown>> => structuredClone(good());
    /** 改一处后的违规全集（拼成一段文本便于断言）。 */
    const violationsOf = (mutate: (events: Array<Record<string, unknown>>) => void): string => {
      const events = clone();
      mutate(events);
      return validateDshEvents(events).join(" | ");
    };

    // 1) seq 不稠密 / time 非法
    expect(violationsOf((events) => { events[1]!.seq = 5; })).toContain("与下标");
    expect(violationsOf((events) => { events[1]!.time = -1; })).toContain("time 不是非负安全整数");
    // 2) turn/step 配对
    expect(violationsOf((events) => { (events[0]!.data as { turn: number }).turn = 2; })).toContain("不是期望的");
    expect(violationsOf((events) => { (events[4]!.data as { step: number }).step = 9; })).toContain("不在 open step 内");
    expect(violationsOf((events) => {
      // 去掉 tool/result：广告了 c1、也启动了，但 step/end 之前没有结算
      events.splice(5, 1);
      events.forEach((event, index) => { event.seq = index; });
    })).toContain("仍未结算");
    // 3) surface 标记与 replace 语义
    expect(violationsOf((events) => { delete events[2]!.surfaceOp; })).toContain("缺少 surfaceOp");
    expect(violationsOf((events) => {
      events.push(manual(8, "user/message", { id: "u2", role: "user", content: [], source: { kind: "user" } }, "append"));
      events[8]!.surfaceOp = { op: "replace", startSeq: 99, endSeq: 100 };
    })).toContain("不在当前 surface 上");
    expect(violationsOf((events) => {
      delete events[5]!.surfaceOp;
      events[5]!.surfaceOp = { op: "replace", startSeq: 2, endSeq: 3 };
      events[5]!.sourceEventSeqs = [2];
    })).toContain("sourceEventSeqs 没有覆盖");
    // 4/5) 广告与 tool/call 匹配
    expect(violationsOf((events) => { (events[4]!.data as { name: string }).name = "other"; })).toContain("没有匹配的已广告工具调用");
    expect(violationsOf((events) => {
      const content = (events[3]!.data as { message: { content: Array<{ id: string }> } }).message.content;
      content[0]!.id = "c9";
    })).toContain("没有已广告的工具生命周期");
    // 6) 未启动且不是修复形态；包装块必须唯一且与 source.callId 一致
    expect(violationsOf((events) => { events.splice(4, 1); events.forEach((event, index) => { event.seq = index; }); })).toContain("尚未启动");
    expect(violationsOf((events) => {
      const message = (events[5]!.data as { message: { content: Array<{ toolCallId: string }> } }).message;
      message.content[0]!.toolCallId = "other";
    })).toContain("必须恰好一个 tool-result 包装块");
    // 7) 修复形态的精确性：错误名/码/文案/无 sourceEventSeqs
    const repairStream = (): Array<Record<string, unknown>> => {
      const events = clone();
      events.splice(4, 1); // 去掉 tool/call，直接让 tool/result 走修复分支
      events.forEach((event, index) => { event.seq = index; });
      const data = events[4]!.data as { error?: Record<string, unknown>; message: { id: string } };
      data.error = { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" };
      data.message.id = "interrupted-tool-result-c1-4";
      (data.message as unknown as { content: Array<{ isError?: boolean; content: Array<{ text: string }> }> }).content[0]!.isError = true;
      const inner = (data.message as unknown as { content: Array<{ content: Array<{ text: string }> }> }).content[0]!;
      inner.content[0]!.text = "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.";
      return events;
    };
    expect(validateDshEvents(repairStream())).toEqual([]);
    expect(validateDshEvents(repairStream().map((event, index) => (index === 4 ? { ...event, sourceEventSeqs: [2] } : event))).join(" | ")).toContain("不是精确的 TOOL_NOT_STARTED 修复形态");
    expect(validateDshEvents(repairStream().map((event, index) => (index === 4 ? { ...event, data: { ...(event.data as object), error: { name: "Other", code: "TOOL_NOT_STARTED" } } } : event))).join(" | ")).toContain("不是精确的 TOOL_NOT_STARTED 修复形态");
  });

  it("跨回合的迟到结果（回合中断后补写）→ 丢弃迟到块 + 补官方修复事件，导出照常成功", () => {
    const base = "2026-10-11T00:00:00.000Z";
    // 真实会话里的形态：a1 广告 c1 → 用户开了新回合 u2 → 结果的补写落在新回合里。
    // dsh 的 tool/result 必须与广告同 step，所以这一块无法结算 → 丢弃，由「工具未启动」修复事件如实表达。
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑" }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }] },
      { id: "u2", role: "user", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "text", text: "算了" }] },
      {
        id: "t-late",
        role: "tool",
        createdAt: "2026-10-11T00:00:03.000Z",
        content: [{ type: "tool_result", toolCallId: "c1", content: "The run was interrupted before this tool finished; no result was produced.", isError: true }],
      },
    ]), "p14-late");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("迟到结果") && warning.includes("无法结算"))).toBe(true);
    expect(build.warnings.some((warning) => warning.includes("工具未启动"))).toBe(true);
    // 迟到结果的内容不再出现在产物里；它被同一 step 的修复事件取代（回合 1 的 step 内结算）
    expect(JSON.stringify(build.events)).not.toContain("no result was produced");
    const results = build.events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(1);
    const data = results[0]!.data as { turn: number; message: { id: string }; error: { code: string } };
    expect([data.turn, data.error.code]).toEqual([1, "TOOL_NOT_STARTED"]);
    expect(data.message.id).toBe(`interrupted-tool-result-c1-${String(results[0]!.seq)}`);
    expect(typesOf(build)).toEqual([
      "turn/start", "step/start", "user/message", "assistant/message", "tool/call", "tool/result",
      "step/end", "turn/end",
      "turn/start", "step/start", "user/message",
      "step/end", "turn/end",
    ]);
  });

  it("同回合重复结算（同一 callId 两条 tool_result）→ 只保留第一条，第二条丢弃", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑" }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }] },
      { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "第一次", isError: false }] },
      { id: "t2", role: "tool", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "第二次", isError: false }] },
    ]), "p14-duplicate");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("重复结果"))).toBe(true);
    expect(JSON.stringify(build.events)).toContain("第一次");
    expect(JSON.stringify(build.events)).not.toContain("第二次");
  });

  it("同回合里同一 callId 被重新广告（结算后再次调用）→ 后一次广告也补修复事件，不误报未结算", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑两次" }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } }] },
      { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "第一次", isError: false }] },
      { id: "a2", role: "assistant", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } }] },
    ]), "p14-readvertised");

    expect(validateDshEvents(build.events)).toEqual([]);
    // 结算 → 重新广告 → 无结果：第二条广告也要按「未结算」补修复（顺序感知的生命周期扫描）
    expect(build.warnings.filter((warning) => warning.includes("工具未启动"))).toHaveLength(1);
    expect(build.events.filter((event) => event.type === "tool/result")).toHaveLength(2);
  });

  it("同回合「结算 → 重新广告 → 再结算」：两条结果都保留（生命周期按顺序抵消）", () => {
    const base = "2026-10-11T00:00:00.000Z";
    const build = buildDshSessionEvents(inputWith([
      { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑两次" }] },
      { id: "a1", role: "assistant", createdAt: "2026-10-11T00:00:01.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } }] },
      { id: "t1", role: "tool", createdAt: "2026-10-11T00:00:02.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "第一次", isError: false }] },
      { id: "a2", role: "assistant", createdAt: "2026-10-11T00:00:03.000Z", content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } }] },
      { id: "t2", role: "tool", createdAt: "2026-10-11T00:00:04.000Z", content: [{ type: "tool_result", toolCallId: "c1", content: "第二次", isError: false }] },
    ]), "p14-resettle");

    expect(validateDshEvents(build.events)).toEqual([]);
    expect(build.warnings.some((warning) => warning.includes("重复结果") || warning.includes("孤儿结果"))).toBe(false);
    expect(JSON.stringify(build.events)).toContain("第一次");
    expect(JSON.stringify(build.events)).toContain("第二次");
    expect(build.events.filter((event) => event.type === "tool/result")).toHaveLength(2);
  });

  it("同一 assistant 消息重复广告同一 callId（畸形输入）→ 结构校验拒绝，写盘门禁拦住", async () => {
    const dshHome = path.join(await tempRoot("owc-p14-gate-"), "dsh-home");
    const base = "2026-10-11T00:00:00.000Z";
    const input: DshExportInput = {
      dshHome,
      cwd: "/tmp/owc-p14-gate-cwd",
      meta: { provider: "demo", model: "demo-model" },
      messages: [
        { id: "u1", role: "user", createdAt: base, content: [{ type: "text", text: "跑" }] },
        {
          id: "a1",
          role: "assistant",
          createdAt: "2026-10-11T00:00:01.000Z",
          content: [
            { type: "tool_call", id: "c1", name: "bash", input: {} },
            { type: "tool_call", id: "c1", name: "bash", input: {} },
          ],
        },
      ],
    };
    // 纯函数仍然返回事件（畸形只在结构校验层被判定）
    const build = buildDshSessionEvents(input, "p14-gate");
    expect(validateDshEvents(build.events).some((violation) => violation.includes("重复广告"))).toBe(true);
    // 落盘门禁：拒绝写出，且连会话目录都不建（校验在任何文件系统改动之前）
    await expect(writeDshSession(input, "p14-gate")).rejects.toThrow(/没有通过 dsh 结构校验/);
    await expect(stat(dshHome)).rejects.toThrow();
  });
});
