/**
 * dsh-sync 导出器：**dsh 官方校验器**验收（M4a 修复后固化进仓库）。
 *
 * 口径：用本仓库的写出器 {@link writeDshSession} 生成真实 v3 文件 → 自家读取器 {@link decodeDshSessionFile}
 * 解码 → 交给 dsh 官方校验器（已构建 lib）校验；与「真机验收脚本」等价，但 fixture 内嵌在这里，
 * 不依赖 /tmp 下的任何脚本或目录。
 *
 * 两层校验：
 * 1. `session-format-v2-to-v3` 的 `restoreReleasedV3Artifact`——v3 自身是否合规（物理写入正确）；
 * 2. `session-format-catalog` 的**完整加载路径**——物理行 → `createRestore(validation:"current")`
 *    → 逐行 `decodeRow` → `finish()`，即 dsh 读会话时「zstd → 行 → v3→v4 迁移 → v4 校验」的真实
 *    链路（v4 的 core session 校验含 `hasProviderModel`：模型归属为空串的会话会在这里被拒）。
 *
 * 覆盖三个场景：普通导出、压缩导出（compaction 生命周期）、子代理子会话（M5a）。
 *
 * **条件跳过**：两个 lib 路径都**只从环境变量读取**（`OWC_DSH_V2_TO_V3_LIB` / `OWC_DSH_CATALOG_LIB`）——
 * 仓库里不内嵌任何机器相关路径；未设置或文件不存在时整组 skip（上游仓库的可选依赖不应阻塞本仓库常规测试）。
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DSH_SYNC_WRITE_GENERATION, decodeDshSessionFile } from "../src/extensions/dsh-sync-dsh.js";
import { writeDshSession, type DshExportInput, type DshExportLedgerCompacted } from "../src/extensions/dsh-sync-export.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** dsh 官方 v2→v3 校验器的已构建入口（`restoreReleasedV3Artifact` 所在模块）；只从环境变量读取。 */
const DSH_V2_TO_V3_LIB = process.env.OWC_DSH_V2_TO_V3_LIB;

/** dsh 官方会话格式目录（catalog）的已构建入口：含 v0→v1→v2→v3→v4 迁移链与 v4 校验；只从环境变量读取。 */
const DSH_CATALOG_LIB = process.env.OWC_DSH_CATALOG_LIB;

/** lib 入口是否可用（未设环境变量或文件不存在 → 对应 describe 整组 skip）。 */
function officialLibAvailable(entry: string | undefined): entry is string {
  return entry !== undefined && entry.length > 0 && existsSync(entry);
}

/** 取已构建 lib 的绝对路径（describe.skipIf 已保证可用；此处兜底给出可读错误）。 */
function officialLibPath(entry: string | undefined, envName: string): string {
  if (!officialLibAvailable(entry)) throw new Error(`未设置或不存在：${envName}`);
  return entry;
}

/** dsh 官方校验器的最小类型视图（只看本验收用到的入参/出参）。 */
interface DshOfficialValidator {
  restoreReleasedV3Artifact(
    artifact: { header: Record<string, unknown>; events: unknown[]; inheritedEventCount: number },
    knownEventTypes: ReadonlySet<string>,
  ): unknown;
}

/** catalog 的最小类型视图（只看本验收用到的调用面）。 */
interface DshFormatCatalog {
  /** 声明父会话名下的全部子会话证据；`[]` = 无子会话。 */
  createSessionFormatCatalogWithChildren(children: unknown[]): {
    /** `validation:"current"` = 迁移到当前代际后跑完整的 v4 校验（真机加载即此形态）。 */
    createRestore(
      header: Record<string, unknown>,
      options: { validation: "current" },
    ): {
      decodeRow(row: Record<string, unknown>): void;
      finish(): { header: Record<string, unknown>; events: Array<Record<string, unknown>>; inheritedEventCount: number };
    };
  };
}

/** 验收 fixture：与真机脚本同构（含 thinking/tool_call/tool_result 的一条完整工具链）。 */
const FIXTURE_MESSAGES: ChatMessage[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: "2026-08-12T03:37:29.000Z" },
  {
    id: "m2",
    role: "assistant",
    content: [
      { type: "thinking", text: "想一下", provider: "demo" },
      { type: "text", text: "调用工具" },
      { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" } },
    ],
    createdAt: "2026-08-12T03:37:30.000Z",
  },
  { id: "m3", role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }], createdAt: "2026-08-12T03:37:31.000Z" },
  { id: "m4", role: "assistant", content: [{ type: "text", text: "完成" }], createdAt: "2026-08-12T03:37:32.000Z" },
];

/** 压缩 fixture：压缩前 3 条消息（m1/m2/m3），锚点 = m3。 */
const FIXTURE_COMPACTED: DshExportLedgerCompacted = {
  uptoIndex: 3,
  uptoMessageId: "m3",
  summary: "前半段摘要",
  createdAt: "2026-08-12T03:37:33.000Z",
};

/**
 * P1-4 四类真实坏输入（都曾静默产出 dsh 拒收的文件，覆盖审查报告里的 a/b/c/d）。
 * 每条场景都必须由写出器**修好之后**过官方校验——修不好就得失败，不许写坏文件。
 */
const INTERRUPTED_MESSAGES: ChatMessage[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "跑一下" }], createdAt: "2026-08-12T03:37:29.000Z" },
  {
    id: "m2",
    role: "assistant",
    content: [
      { type: "text", text: "调用工具" },
      { type: "tool_call", id: "c-interrupted", name: "bash", input: { cmd: "sleep 100" } },
    ],
    createdAt: "2026-08-12T03:37:30.000Z",
  },
];

/** b：孤儿 tool_result（`!cmd` 直写路径没有 assistant 广告）+ 一条合法工具链。 */
const ORPHAN_MESSAGES: ChatMessage[] = [
  ...FIXTURE_MESSAGES,
  { id: "m5", role: "user", content: [{ type: "text", text: "!pwd" }], createdAt: "2026-08-12T03:37:34.000Z" },
  { id: "m6", role: "tool", content: [{ type: "tool_result", toolCallId: "shell-cmd-m5", content: "/tmp", isError: false }], createdAt: "2026-08-12T03:37:35.000Z" },
  { id: "m7", role: "assistant", content: [{ type: "text", text: "完成" }], createdAt: "2026-08-12T03:37:36.000Z" },
];

/** c：一条 tool 消息含两个 tool_result 块（并行工具调用）。 */
const MULTI_RESULT_MESSAGES: ChatMessage[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "并行两个" }], createdAt: "2026-08-12T03:37:29.000Z" },
  {
    id: "m2",
    role: "assistant",
    content: [
      { type: "tool_call", id: "c1", name: "bash", input: { cmd: "a" } },
      { type: "tool_call", id: "c2", name: "read_file", input: { path: "b" } },
    ],
    createdAt: "2026-08-12T03:37:30.000Z",
  },
  {
    id: "m3",
    role: "tool",
    content: [
      { type: "tool_result", toolCallId: "c1", content: "a-ok", isError: false },
      { type: "tool_result", toolCallId: "c2", content: "b-ok", isError: false },
    ],
    createdAt: "2026-08-12T03:37:31.000Z",
  },
  { id: "m4", role: "assistant", content: [{ type: "text", text: "完成" }], createdAt: "2026-08-12T03:37:32.000Z" },
];

/** d：消息列表首条不是 user（`POST /api/sessions/import` 导入的任意 JSONL）。 */
const ASSISTANT_FIRST_MESSAGES: ChatMessage[] = [
  { id: "m2", role: "assistant", content: [{ type: "text", text: "历史被截断" }], createdAt: "2026-08-12T03:37:30.000Z" },
  { id: "m1", role: "user", content: [{ type: "text", text: "继续" }], createdAt: "2026-08-12T03:37:29.000Z" },
  { id: "m4", role: "assistant", content: [{ type: "text", text: "好的" }], createdAt: "2026-08-12T03:37:32.000Z" },
];

/**
 * 第五类（21 个真机会话核对过的最常见形态）：回合被中断后，结果的补写落在**下一个回合**里
 * （owc 补写的正文是 `The run was interrupted before this tool finished…`）。
 * dsh 的 `tool/result` 必须与广告同 step，因此这一块只能丢弃，由「工具未启动」修复事件表达同一件事。
 */
const LATE_RESULT_MESSAGES: ChatMessage[] = [
  { id: "m1", role: "user", content: [{ type: "text", text: "跑一下" }], createdAt: "2026-08-12T03:37:29.000Z" },
  {
    id: "m2",
    role: "assistant",
    content: [{ type: "tool_call", id: "late-call", name: "bash", input: { cmd: "sleep 100" } }],
    createdAt: "2026-08-12T03:37:30.000Z",
  },
  { id: "m5", role: "user", content: [{ type: "text", text: "算了，先看别的" }], createdAt: "2026-08-12T03:37:31.000Z" },
  {
    id: "m6",
    role: "tool",
    content: [{ type: "tool_result", toolCallId: "late-call", content: "The run was interrupted before this tool finished; no result was produced.", isError: true }],
    createdAt: "2026-08-12T03:37:32.000Z",
  },
];

/** 1×1 PNG（真实字节，用于 tool_result.media[] 的图片导出验收）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7GvHAAAAAElFTkSuQmCC",
  "base64",
);

/** 事件类型序列。 */
function types(events: readonly Record<string, unknown>[]): string[] {
  return events.map((event) => String(event.type));
}

/**
 * 走一遍「写出 → 解码 → dsh 官方校验」（`restoreReleasedV3Artifact`）。
 *
 * 用**真实写出器 + 真实解码器**：校验的是字节落盘链路，不是内存对象。
 * @param sessionId - 本次导出的会话 id（固定值便于断言事件）。
 * @param options - `compacted` 给出则导出压缩生命周期；`messages` 覆盖消息列表（P1-4 修复场景用）。
 * @returns 解码后的事件序列与写出器的降级警告。
 */
async function exportScenario(
  sessionId: string,
  options: { compacted?: DshExportLedgerCompacted; messages?: ChatMessage[] } = {},
): Promise<{ events: Array<Record<string, unknown>>; warnings: string[] }> {
  const dshHome = await tempRoot("owc-dsh-official-");
  const cwd = await tempRoot("owc-dsh-official-cwd-");
  const input: DshExportInput = {
    dshHome,
    cwd,
    meta: { title: "验收会话", createdAt: "2026-08-12T03:37:28.722Z", provider: "demo", model: "demo-model" },
    messages: options.messages ?? FIXTURE_MESSAGES,
    ...(options.compacted === undefined ? {} : { ledger: { compacted: options.compacted } }),
  };
  const result = await writeDshSession(input, sessionId);
  const decoded = await decodeDshSessionFile({
    file: result.file,
    generation: DSH_SYNC_WRITE_GENERATION,
    compressed: true,
  });
  expect(decoded.events).toHaveLength(result.eventCount);
  const validator = await import(/* @vite-ignore */ pathToFileURL(officialLibPath(DSH_V2_TO_V3_LIB, "OWC_DSH_V2_TO_V3_LIB")).href) as DshOfficialValidator;
  // dsh 的逻辑头行没有物理层的 `type: "session"` 字段。
  const { type: _physical, ...logicalHeader } = decoded.header as Record<string, unknown>;
  expect(typeof validator.restoreReleasedV3Artifact).toBe("function");
  expect(() =>
    validator.restoreReleasedV3Artifact(
      { header: logicalHeader, events: decoded.events, inheritedEventCount: 0 },
      new Set(decoded.events.map((event) => String(event.type))),
    )).not.toThrow();
  return { events: decoded.events as Array<Record<string, unknown>>, warnings: result.warnings };
}

/**
 * 无降级警告的常规验收（消息列表固定为 FIXTURE_MESSAGES）。
 * @param sessionId - 本次导出的会话 id。
 * @param compacted - 可选的压缩记录（不给则不导出压缩）。
 * @returns 解码后的事件序列（供调用方追加断言）。
 */
async function exportAndValidate(sessionId: string, compacted?: DshExportLedgerCompacted): Promise<Array<Record<string, unknown>>> {
  const { events, warnings } = await exportScenario(sessionId, compacted === undefined ? {} : { compacted });
  expect(warnings).toEqual([]);
  return events;
}

/**
 * 导出 fixture 会话并用自家读取器取回**物理行**（头行 + 事件行）：完整加载路径的输入。
 *
 * 物理行 = 文件里的 JSONL 行；本仓库读取器返回的就是逐行 JSON.parse 的结果（头行仍带物理层
 * `type: "session"`），因此可直接喂给 catalog 的 `decodeRow`。
 * @param sessionId - 本次导出的会话 id。
 * @param options - `compacted` 给出则导出压缩生命周期；`subagent` 给出则导出子代理子会话头行；
 *   `messages` 覆盖消息列表（P1-4 修复场景用，此时不要求零警告）。
 * @returns 物理行（首项为头行）与落盘文件路径。
 */
async function exportRows(
  sessionId: string,
  options: {
    compacted?: DshExportLedgerCompacted;
    subagent?: { parentSession: string; agentPreset?: string };
    messages?: ChatMessage[];
    providerInterfaces?: Record<string, "anthropic-messages" | "openai-responses" | "openai-chat-completions">;
  } = {},
): Promise<{ rows: Array<Record<string, unknown>>; file: string }> {
  const dshHome = await tempRoot("owc-dsh-catalog-");
  const cwd = await tempRoot("owc-dsh-catalog-cwd-");
  const result = await writeDshSession({
    dshHome,
    cwd,
    meta: { title: "完整加载路径验收", createdAt: "2026-08-12T03:37:28.722Z", provider: "demo", model: "demo-model" },
    messages: options.messages ?? FIXTURE_MESSAGES,
    ...(options.compacted === undefined ? {} : { ledger: { compacted: options.compacted } }),
    ...(options.subagent === undefined ? {} : { subagent: options.subagent }),
    ...(options.providerInterfaces === undefined ? {} : { providerInterfaces: options.providerInterfaces }),
  }, sessionId);
  if (options.messages === undefined) expect(result.warnings).toEqual([]);
  const decoded = await decodeDshSessionFile({
    file: result.file,
    generation: DSH_SYNC_WRITE_GENERATION,
    compressed: true,
  });
  return { rows: [decoded.header, ...decoded.events] as Array<Record<string, unknown>>, file: result.file };
}

/**
 * 走 dsh 真实加载路径：物理行 → `createRestore(validation:"current")` → 逐行 `decodeRow` → `finish()`。
 * @param rows - 物理行（首项为头行）。
 * @returns 迁移 + 校验后的 v4 逻辑 artifact。
 */
async function loadThroughCatalog(rows: Array<Record<string, unknown>>): Promise<{
  header: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  inheritedEventCount: number;
}> {
  const catalog = await import(/* @vite-ignore */ pathToFileURL(officialLibPath(DSH_CATALOG_LIB, "OWC_DSH_CATALOG_LIB")).href) as DshFormatCatalog;
  expect(typeof catalog.createSessionFormatCatalogWithChildren).toBe("function");
  const restore = catalog.createSessionFormatCatalogWithChildren([]).createRestore(rows[0]!, { validation: "current" });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  return restore.finish();
}

describe.skipIf(!officialLibAvailable(DSH_V2_TO_V3_LIB))("dsh 官方校验：restoreReleasedV3Artifact", () => {
  it("普通导出通过官方校验（工具生命周期：assistant/message 广告在前、tool/call 在后）", async () => {
    const events = await exportAndValidate("official-plain");
    expect(events.map((event) => String(event.type))).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/result",
      "assistant/message",
      "step/end", "turn/end",
      "session/title",
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
  });

  it("压缩导出通过官方校验（compaction 生命周期 + checkpoint user/message 的 surface replace）", async () => {
    const events = await exportAndValidate("official-compacted", FIXTURE_COMPACTED);
    expect(events.map((event) => String(event.type))).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/result",
      "assistant/message",
      "step/end", "turn/end",
      "session/title",
      "compaction/start", "compaction/summary", "user/message", "compaction/end",
    ]);
    // 被压缩前缀 span：surface = [2(user), 3(assistant), 5(tool/result), 6(assistant)]，span 取前三项
    const summary = events.find((event) => event.type === "compaction/summary")!;
    expect(summary.data).toMatchObject({
      compactionId: "owc-compaction-official-compacted",
      shadowedRange: { start: 2, end: 5 },
      shadowedSeqs: [2, 3, 5],
      provider: "demo",
      model: "demo-model",
    });
    const checkpoint = events.find((event) => event.type === "user/message" && event.surfaceOp !== "append")!;
    expect(checkpoint.surfaceOp).toEqual({ op: "replace", startSeq: 2, endSeq: 5 });
    expect(checkpoint.sourceEventSeqs).toEqual([2, 3, 5]);
    expect((checkpoint.data as { source: unknown }).source).toEqual({
      kind: "plugin",
      plugin: "compact",
      compactionId: "owc-compaction-official-compacted",
    });
  });

  it("anthropic-messages 的 replayState（thinking 签名）与 tool_result.media[] 图片一起通过官方校验", async () => {
    const dshHome = await tempRoot("owc-dsh-official-replay-");
    const cwd = await tempRoot("owc-dsh-official-replay-cwd-");
    // 与真机同构：thinking 带 signature + 一条工具结果带 media[] 图片（read_media 路径）
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: [{ type: "text", text: "看图" }], createdAt: "2026-08-12T03:37:29.000Z" },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "thinking", text: "想一下", provider: "demo", signature: "sig-abc", redacted: "cipher-abc" },
          { type: "tool_call", id: "c1", name: "read_media", input: { path: "a.png" } },
        ],
        createdAt: "2026-08-12T03:37:30.000Z",
      },
      {
        id: "m3",
        role: "tool",
        content: [{
          type: "tool_result",
          toolCallId: "c1",
          content: "见图",
          isError: false,
          media: [{ type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") }],
        }],
        createdAt: "2026-08-12T03:37:31.000Z",
      },
    ];
    const result = await writeDshSession({
      dshHome,
      cwd,
      meta: { title: "回放元数据", createdAt: "2026-08-12T03:37:28.722Z", provider: "demo", model: "demo-model" },
      messages,
      providerInterfaces: { demo: "anthropic-messages" },
    }, "official-replay");
    expect(result.warnings).toEqual([]);
    expect(result.attachments).toBe(1);
    const decoded = await decodeDshSessionFile({
      file: result.file,
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    const assistant = decoded.events.find((event) => event.type === "assistant/message")!;
    expect((assistant.data as { message: { source: Record<string, unknown> } }).message.source).toMatchObject({
      kind: "model",
      provider: "demo",
      model: "demo-model",
      replayState: {
        response: { kind: "llm-service-lite-anthropic", version: 1 },
        blocks: [{ type: "reasoning", signature: "sig-abc", redacted: "cipher-abc" }, { type: "tool-call" }],
      },
    });
    // 工具结果里的图片已作为 tool-result 包装块的子块落盘
    const toolEvent = decoded.events.find((event) => event.type === "tool/result")!;
    const wrapper = (toolEvent.data as { message: { content: Array<{ content?: Array<{ type: string }> }> } }).message.content[0]!;
    expect(wrapper.content?.map((block) => block.type)).toEqual(["text", "image"]);

    const { type: _physical, ...logicalHeader } = decoded.header as Record<string, unknown>;
    const validator = await import(/* @vite-ignore */ pathToFileURL(DSH_V2_TO_V3_LIB).href) as DshOfficialValidator;
    expect(() =>
      validator.restoreReleasedV3Artifact(
        { header: logicalHeader, events: decoded.events, inheritedEventCount: 0 },
        new Set(decoded.events.map((event) => String(event.type))),
      )).not.toThrow();
  });

  it("子代理子会话通过官方校验（origin/parentSession/delegationDepth/agentPreset 头行）", async () => {
    const dshHome = await tempRoot("owc-dsh-official-sub-");
    const cwd = await tempRoot("owc-dsh-official-sub-cwd-");
    const parentId = "11111111-2222-4333-8444-555566667777";
    const result = await writeDshSession({
      dshHome,
      cwd,
      meta: { title: "子代理会话", createdAt: "2026-08-12T03:37:40.000Z", provider: "demo", model: "demo-model" },
      messages: FIXTURE_MESSAGES,
      subagent: { parentSession: parentId, agentPreset: "explore" },
    });
    expect(result.warnings).toEqual([]);
    const decoded = await decodeDshSessionFile({
      file: result.file,
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    expect(decoded.header).toMatchObject({
      origin: "subagent",
      parentSession: parentId,
      delegationDepth: 1,
      agentPreset: "explore",
      cwd,
    });
    const { type: _physical, ...logicalHeader } = decoded.header as Record<string, unknown>;
    const validator = await import(/* @vite-ignore */ pathToFileURL(officialLibPath(DSH_V2_TO_V3_LIB, "OWC_DSH_V2_TO_V3_LIB")).href) as DshOfficialValidator;
    expect(() =>
      validator.restoreReleasedV3Artifact(
        { header: logicalHeader, events: decoded.events, inheritedEventCount: 0 },
        new Set(decoded.events.map((event) => String(event.type))),
      )).not.toThrow();
  });
});

/**
 * P1-4 场景：导出方向的四类真实坏输入——a 未结算工具调用 / b 孤儿 tool_result / c 一条 tool 消息多结果 /
 * d 消息列表首条不是 user。修复前它们分别触发上游的
 * `step/end leaves unresolved tool call`、`tool/result ... has no advertised tool lifecycle`、
 * `requires exactly one tool-result wrapper matching its tool source`、
 * `assistant/message does not match an open turn and step`；修复后必须**全部 PASS**。
 */
describe.skipIf(!existsSync(DSH_V2_TO_V3_LIB))("dsh 官方校验：P1-4 导出关系修复", () => {
  it("a 未结算工具调用（回合中断）→ 合成 TOOL_NOT_STARTED 修复事件后通过官方校验", async () => {
    const { events, warnings } = await exportScenario("official-interrupted", { messages: INTERRUPTED_MESSAGES });
    expect(types(events)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call",
      "tool/result",
      "step/end", "turn/end",
      "session/title",
    ]);
    const repair = events.find((event) => event.type === "tool/result")!;
    expect(repair.data).toMatchObject({
      turn: 1,
      step: 1,
      error: { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" },
    });
    // message.id 的规范形态：interrupted-tool-result-<callId>-<该事件最终 seq>
    const message = (repair.data as { message: { id: string; role: string; source: { kind: string; callId: string }; content: Array<{ type: string; isError?: boolean }> } }).message;
    expect(message).toMatchObject({ role: "user", source: { kind: "tool", callId: "c-interrupted" } });
    expect(message.content).toHaveLength(1);
    expect(message.content[0]).toMatchObject({ type: "tool-result", isError: true });
    expect(message.id).toBe(`interrupted-tool-result-c-interrupted-${String(repair.seq)}`);
    expect(warnings.some((warning) => warning.includes("工具未启动"))).toBe(true);
  });

  it("b 孤儿 tool_result 丢弃后通过官方校验（同批合法工具链保留）", async () => {
    const { events, warnings } = await exportScenario("official-orphan", { messages: ORPHAN_MESSAGES });
    expect(warnings.some((warning) => warning.includes("孤儿结果"))).toBe(true);
    expect(events.filter((event) => event.type === "tool/result")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("shell-cmd-m5");
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
  });

  it("c 一条 tool 消息含两个 tool_result 块 → 拆分后通过官方校验", async () => {
    const { events, warnings } = await exportScenario("official-multi-result", { messages: MULTI_RESULT_MESSAGES });
    expect(warnings.some((warning) => warning.includes("已拆成 2 条单块消息"))).toBe(true);
    const results = events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(2);
    expect(results.map((event) => {
      const data = event.data as { message: { id: string; source: { callId: string }; content: unknown[] } };
      return [data.message.id, data.message.source.callId, data.message.content.length];
    })).toEqual([["m3-0", "c1", 1], ["m3-1", "c2", 1]]);
  });

  it("d 消息列表首条不是 user → 补 turn/start + step/start 后通过官方校验", async () => {
    const { events, warnings } = await exportScenario("official-assistant-first", { messages: ASSISTANT_FIRST_MESSAGES });
    expect(types(events).slice(0, 3)).toEqual(["turn/start", "step/start", "assistant/message"]);
    expect(events[0]!.data).toEqual({ turn: 1 });
    expect(events[1]!.data).toEqual({ turn: 1, step: 1 });
    expect(warnings.some((warning) => warning.includes("首条消息不是用户消息"))).toBe(true);
  });

  it("跨回合的迟到结果（真机数据集里最常见的形态）→ 丢弃 + 官方修复后通过官方校验", async () => {
    const { events, warnings } = await exportScenario("official-late-result", { messages: LATE_RESULT_MESSAGES });
    expect(warnings.some((warning) => warning.includes("迟到结果"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("工具未启动"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("no result was produced");
    const repair = events.find((event) => event.type === "tool/result")!;
    expect((repair.data as { turn: number; error: { code: string } })).toMatchObject({ turn: 1, error: { code: "TOOL_NOT_STARTED" } });
  });
});

/**
 * 完整加载路径（v3 → v4）：用 dsh `session-format-catalog` 的已构建 lib 复刻真机读盘链路。
 *
 * 与上面的 v2→v3 校验互补：那一层只看「v3 写得对不对」，这一层看「dsh 当前版本能不能真的load」——
 * `validation:"current"` 会跑完 v0→v1→v2→v3→v4 迁移链并对 v4 逻辑 artifact 跑 core session 校验
 * （含 assistant 消息的 `hasProviderModel`：导出时 provider/model 为空串的会话会在这里被拒）。
 */
describe.skipIf(!officialLibAvailable(DSH_CATALOG_LIB))("dsh 完整加载路径：v3 → v4（session-format-catalog）", () => {
  it("普通导出：迁移到 v4 且事件序列/类型不变（工具生命周期保持）", async () => {
    const { rows } = await exportRows("catalog-plain");
    const artifact = await loadThroughCatalog(rows);
    expect(artifact.header.version).toBe(4);
    expect(artifact.header).toMatchObject({ id: "catalog-plain", cwd: expect.stringContaining("owc-dsh-catalog-cwd-") });
    expect(artifact.inheritedEventCount).toBe(0);
    expect(artifact.events.map((event) => event.type)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/result",
      "assistant/message",
      "step/end", "turn/end",
      "session/title",
    ]);
    expect(artifact.events.map((event) => event.seq)).toEqual(artifact.events.map((_event, index) => index));
    // v4 校验的模型归属：assistant 的 source.provider/model 均非空（hasProviderModel）
    const source = (artifact.events.find((event) => event.type === "assistant/message")!.data as {
      message: { source: Record<string, unknown> };
    }).message.source;
    expect(source).toEqual({ kind: "model", provider: "demo", model: "demo-model" });
  });

  it("压缩导出：compaction 生命周期与 checkpoint surface replace 在 v4 下保持", async () => {
    const { rows } = await exportRows("catalog-compacted", { compacted: FIXTURE_COMPACTED });
    const artifact = await loadThroughCatalog(rows);
    expect(artifact.header.version).toBe(4);
    expect(artifact.events.map((event) => event.type)).toEqual([
      "turn/start", "step/start", "user/message",
      "assistant/message", "tool/call", "tool/result",
      "assistant/message",
      "step/end", "turn/end",
      "session/title",
      "compaction/start", "compaction/summary", "user/message", "compaction/end",
    ]);
    const summary = artifact.events.find((event) => event.type === "compaction/summary")!;
    expect(summary.data).toMatchObject({
      compactionId: "owc-compaction-catalog-compacted",
      shadowedRange: { start: 2, end: 5 },
      shadowedSeqs: [2, 3, 5],
      provider: "demo",
      model: "demo-model",
    });
    const checkpoint = artifact.events.find((event) => event.type === "user/message" && event.surfaceOp !== "append")!;
    expect(checkpoint.surfaceOp).toEqual({ op: "replace", startSeq: 2, endSeq: 5 });
  });

  it("子代理导出：v4 头行保留 origin/parentSession/delegationDepth/agentPreset", async () => {
    const parentId = "11111111-2222-4333-8444-555566667777";
    const { rows } = await exportRows("catalog-subagent", { subagent: { parentSession: parentId, agentPreset: "explore" } });
    const artifact = await loadThroughCatalog(rows);
    expect(artifact.header.version).toBe(4);
    expect(artifact.header).toMatchObject({
      id: "catalog-subagent",
      origin: "subagent",
      parentSession: parentId,
      delegationDepth: 1,
      agentPreset: "explore",
    });
    expect(artifact.events.some((event) => event.type === "assistant/message")).toBe(true);
  });

  it("replayState 与 tool-result 内图片在 v4 完整加载路径下保留（模型 source 的额外键被允许）", async () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: [{ type: "text", text: "看图" }], createdAt: "2026-08-12T03:37:29.000Z" },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "thinking", text: "想一下", provider: "demo", signature: "sig-abc" },
          { type: "text", text: "读图", textSignature: JSON.stringify({ v: 1, id: "msg_1" }) },
          { type: "tool_call", id: "c1", name: "read_media", input: { path: "a.png" }, itemId: "fc_1" },
        ],
        createdAt: "2026-08-12T03:37:30.000Z",
      },
      {
        id: "m3",
        role: "tool",
        content: [{
          type: "tool_result",
          toolCallId: "c1",
          content: "见图",
          isError: false,
          media: [{ type: "image", mediaType: "image/png", data: PNG_1X1.toString("base64") }],
        }],
        createdAt: "2026-08-12T03:37:31.000Z",
      },
    ];
    const { rows } = await exportRows("catalog-replay", {
      messages,
      providerInterfaces: { demo: "openai-responses" },
    });
    const artifact = await loadThroughCatalog(rows);
    expect(artifact.header.version).toBe(4);
    // 模型 source 的额外键 replayState 原样保留（v3→v4 迁移不动 message source 的非身份字段）
    const source = (artifact.events.find((event) => event.type === "assistant/message")!.data as {
      message: { source: Record<string, unknown> };
    }).message.source;
    expect(source.replayState).toEqual({
      response: { kind: "llm-service-lite-responses", version: 1 },
      blocks: [
        { type: "reasoning", item: "sig-abc" },
        { type: "text", itemId: "msg_1" },
        { type: "tool-call", itemId: "fc_1" },
      ],
    });
    // v4 的一等 tool 消息把包装块提升为 content 块（图片随之成为 tool 消息的内容块）
    const toolEvent = artifact.events.find((event) => event.type === "tool/result")!;
    const toolMessage = (toolEvent.data as { message: { role: string; content: Array<{ type: string }> } }).message;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("P1-4a 未结算修复：v3 → v4 迁移后仍是一等的「工具未启动」修复（toolCallId/isError/error 齐备）", async () => {
    const { rows } = await exportRows("catalog-interrupted", { messages: INTERRUPTED_MESSAGES });
    const artifact = await loadThroughCatalog(rows);
    expect(artifact.header.version).toBe(4);
    const repair = artifact.events.find((event) => event.type === "tool/result")!;
    // v4 把 v3 的 tool-result 包装块提升为一等 tool 角色消息（toolCallId/isError 提到 message 上）
    expect((repair.data as { message: Record<string, unknown> }).message).toMatchObject({
      role: "tool",
      toolCallId: "c-interrupted",
      isError: true,
    });
    expect((repair.data as { error: Record<string, unknown> }).error).toEqual({ name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" });
  });

  it("P1-4b/c/d + 跨回合迟到结果：清洗/修复后同样能走完 v4 完整加载", async () => {
    const scenarios: Array<[string, ChatMessage[]]> = [
      ["catalog-orphan", ORPHAN_MESSAGES],
      ["catalog-multi-result", MULTI_RESULT_MESSAGES],
      ["catalog-assistant-first", ASSISTANT_FIRST_MESSAGES],
      ["catalog-late-result", LATE_RESULT_MESSAGES],
    ];
    for (const [sessionId, messages] of scenarios) {
      const { rows } = await exportRows(sessionId, { messages });
      const artifact = await loadThroughCatalog(rows);
      expect(artifact.header.version).toBe(4);
      expect(artifact.events.map((event) => event.seq)).toEqual(artifact.events.map((_event, index) => index));
      expect(artifact.events.some((event) => event.type === "user/message")).toBe(true);
    }
  });
});

/**
 * 反例（缺陷前提）：会话缺模型归属时，写出器会照实写空串，dsh 当前版本（v4）的 core session
 * 校验会**拒绝**整个会话——这正是导出路由必须先做「模型归属补全（fill-or-skip）」的原因。
 * 这一条把缺陷前提钉在测试里：上游哪天放宽校验，这里会先失败提醒重新评估 fill 策略。
 */
describe.skipIf(!officialLibAvailable(DSH_CATALOG_LIB))("dsh 完整加载路径：模型归属为空串会被拒（缺陷前提）", () => {
  it("provider 非空 + model 空串 → catalog 迁移到 v4 时报 model source", async () => {
    const dshHome = await tempRoot("owc-dsh-catalog-empty-");
    const cwd = await tempRoot("owc-dsh-catalog-empty-cwd-");
    const result = await writeDshSession({
      dshHome,
      cwd,
      meta: { title: "空归属", createdAt: "2026-08-12T03:37:28.722Z", provider: "demo", model: "" },
      messages: FIXTURE_MESSAGES,
    }, "catalog-empty-attribution");
    // 写出器如实记录降级（不编造归属）
    expect(result.warnings.some((warning) => warning.includes("未提供 meta.provider/model"))).toBe(true);
    const decoded = await decodeDshSessionFile({
      file: result.file,
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    const rows = [decoded.header, ...decoded.events] as Array<Record<string, unknown>>;
    await expect(loadThroughCatalog(rows)).rejects.toThrow(/model source/);
  });
});
