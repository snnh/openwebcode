/**
 * dsh-sync M3a（dsh v3/v4 会话 → owc 会话：纯转换模块 + sessions.import + SessionStore.replaceJsonl）单测。
 *
 * 覆盖四层：
 * 1. {@link convertDshSession} 的映射表（三人称转换、内容块降级、surface replace 就地替换、
 *    压缩锚点（含 checkpoint）、孤儿配对校验、元信息、v4 fixture 端到端）；
 * 2. {@link SessionStore.replaceJsonl} 的落盘语义（备份、ledger 删除、原安全字段保留、净化、不存在时报错）；
 * 3. `sessions.import` 经 {@link ExtensionManager} 白盒分发（权限门 + 可选 ledger 落盘 + 覆盖/新建两种语义）；
 * 4. manifest 的权限/版本声明。
 *
 * 事件数组以手工构造为主（本模块是纯函数，输入即事件信封）；v4 形态用 fixture 文件核对。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeDshSessionFile, scanDshSessions } from "../src/extensions/dsh-sync-dsh.js";
import { convertDshSession, type ConversionCounts, type ConversionReport } from "../src/extensions/dsh-sync-session.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import type { ExtensionManifest } from "../src/extensions/types.js";
import { ContextManager } from "../src/context/context-manager.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** dsh-sync fixture 根（只读）。 */
const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-sync", import.meta.url));
/** fixture 里的 v4 zstd 会话（dsh 当前代际）。 */
const V4_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

/** 头行 createdAt（毫秒）与事件 time 基准。 */
const T0 = 1_700_000_000_000;

/** 毫秒 → ISO（断言用）。 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** v3 头行（用例只关心 createdAt/cwd/id）。 */
function dshHeader(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "session", version: 3, id: "dsh-1", createdAt: T0, isSeeded: false, delegationDepth: 0, ...extra };
}

/** 一个 envelope 完整的事件。 */
function event(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time: T0 + seq, data, ...extra };
}

/** surface 事件（默认 append）。 */
function surface(seq: number, type: string, data: unknown, surfaceOp: unknown = "append"): Record<string, unknown> {
  return event(seq, type, data, { surfaceOp });
}

/** `user/message` 的 data（v3 里 data 即 UserMessage）。 */
function userData(id: string, content: unknown[]): Record<string, unknown> {
  return { id, role: "user", content, source: { kind: "user" } };
}

/** `assistant/message` 的 data（message 嵌在 data.message 里）。 */
function assistantData(id: string, content: unknown[], source: Record<string, unknown>): Record<string, unknown> {
  return { turn: 1, step: 1, message: { id, role: "assistant", content, source: { kind: "model", ...source } }, stream: [] };
}

/** `tool/result` 的 data（v3 规范形态：message.content 只含一个 tool-result 块）。 */
function toolResultData(id: string, toolCallId: string, content: unknown[], isError = false): Record<string, unknown> {
  return {
    turn: 1,
    step: 1,
    message: {
      id,
      role: "tool",
      toolCallId,
      ...(isError ? { isError: true } : {}),
      content: [{ type: "tool-result", toolCallId, content, ...(isError ? { isError: true } : {}) }],
      source: { kind: "tool", callId: toolCallId },
    },
  };
}

describe("convertDshSession：三人称基础映射", () => {
  const events: Array<Record<string, unknown>> = [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surface(2, "user/message", userData("u-1", [{ type: "text", text: "帮我看看 a.txt" }])),
    surface(3, "assistant/message", assistantData(
      "a-1",
      [
        { type: "text", text: "我先读文件" },
        { type: "reasoning", text: "需要先确认路径" },
        { type: "tool-call", id: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      ],
      {
        provider: "gateway",
        model: "gpt-x",
        // reasoning 的 signature/redacted 实际落在 replayState.blocks（与 content 逐位对齐）
        replayState: { response: { kind: "replay" }, blocks: [{ type: "text" }, { type: "reasoning", signature: "sig-1" }, { type: "tool-call" }] },
      },
    )),
    event(4, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }),
    surface(5, "tool/result", toolResultData("t-1", "call-1", [{ type: "text", text: "file body" }])),
    event(6, "step/end", { turn: 1, step: 1 }),
    event(7, "turn/end", { turn: 1, reason: "completed" }),
    event(8, "session/end-seed", { inherited: true }),
  ];

  it("三角色消息转换 + 内容块字段（thinking.provider / replay signature / tool_call.input）", () => {
    const conversion = convertDshSession(dshHeader({ cwd: "/work/demo" }), events);
    // 报告形状（ConversionReport/ConversionCounts）就是 M3b 宿主侧的消费契约：
    // 显式标注一次，后续重构悄悄改窄字段时这里先炸。
    const report: ConversionReport = conversion.report;
    const counts: ConversionCounts = report.counts;
    expect(conversion.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(conversion.messages.map((message) => message.id)).toEqual(["u-1", "a-1", "t-1"]);
    expect(conversion.messages.map((message) => message.createdAt)).toEqual([iso(T0 + 2), iso(T0 + 3), iso(T0 + 5)]);

    const assistant = conversion.messages[1]!;
    expect(assistant.content[0]).toEqual({ type: "text", text: "我先读文件" });
    expect(assistant.content[1]).toEqual({ type: "thinking", text: "需要先确认路径", provider: "gateway", signature: "sig-1" });
    expect(assistant.content[2]).toEqual({ type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } });

    expect(conversion.messages[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "call-1", content: "file body", isError: false },
    ]);
    expect(conversion.meta).toEqual({ cwd: "/work/demo", createdAt: iso(T0) });
    expect(counts).toEqual({ user: 1, assistant: 1, tool: 1, images: 0, imagesMissing: 0 });
    // turn/step 类事件丢弃计数；tool/call 已被 assistant 的 tool-call 块承载，同样只计数
    expect(report.droppedEvents).toEqual({
      "session/end-seed": 1,
      "step/end": 1,
      "step/start": 1,
      "tool/call": 1,
      "turn/end": 1,
      "turn/start": 1,
    });
    expect(report.warnings).toEqual([]);
    expect(conversion.ledger).toBeUndefined();
  });

  it("provider 缺失 → thinking.provider 兜底 \"dsh\"；消息 id 缺失 → 确定性 dsh-<seq>", () => {
    const events: Array<Record<string, unknown>> = [
      // 裸 data：message 无 id、无 source（provider 归属缺失）
      surface(0, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "思考" }] }, stream: [] }),
      surface(1, "user/message", { role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages.map((message) => message.id)).toEqual(["dsh-0", "dsh-1"]);
    expect(conversion.messages[0]!.content[0]).toEqual({ type: "thinking", text: "思考", provider: "dsh" });
  });
});

describe("convertDshSession：surface 重建（surfaceOp replace）", () => {
  it("替换后旧 surface 消失，被遮蔽项计入丢弃账", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "user/message", userData("old-user", [{ type: "text", text: "旧问题" }])),
      surface(1, "assistant/message", assistantData("old-assistant", [{ type: "text", text: "旧回答" }], { provider: "p", model: "m" })),
      surface(2, "user/message", userData("new-user", [{ type: "text", text: "新问题" }]), { op: "replace", startSeq: 0, endSeq: 1 }),
      surface(3, "assistant/message", assistantData("new-assistant", [{ type: "text", text: "新回答" }], { provider: "p", model: "m" })),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages.map((message) => message.id)).toEqual(["new-user", "new-assistant"]);
    expect(conversion.report.droppedEvents).toEqual({ "assistant/message": 1, "user/message": 1 });
    expect(conversion.report.warnings.some((warning) => warning.includes("被 surfaceOp replace 遮蔽"))).toBe(true);
  });

  it("中段 replace 就地替换：替换者留在被替换区间的位置（不挪到末尾）", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "user/message", userData("u1", [{ type: "text", text: "问题一" }])),
      surface(1, "assistant/message", assistantData("a1", [{ type: "text", text: "回答一" }], { provider: "p", model: "m" })),
      surface(2, "user/message", userData("u2", [{ type: "text", text: "问题二" }])),
      surface(3, "assistant/message", assistantData("a2", [{ type: "text", text: "回答二" }], { provider: "p", model: "m" })),
      surface(4, "user/message", userData("u3", [{ type: "text", text: "问题三" }])),
      // 压缩 checkpoint 原位替换 u2/a2 这一段（dsh 语义：splice(first, removed.length, seq)）
      surface(5, "user/message", {
        ...userData("ckpt", [{ type: "text", text: "摘要" }]),
        source: { kind: "plugin", plugin: "compact", compactionId: "c1" },
      }, { op: "replace", startSeq: 2, endSeq: 3 }),
      surface(6, "assistant/message", assistantData("a3", [{ type: "text", text: "回答三" }], { provider: "p", model: "m" })),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    // 替换者落在 u2 的位置（u1,a1 之前、u3 之后），而不是被挪到末尾
    expect(conversion.messages.map((message) => message.id)).toEqual(["u1", "a1", "ckpt", "u3", "a3"]);
    expect(conversion.report.droppedEvents).toEqual({ "assistant/message": 1, "user/message": 1 });
  });

  it("system/message 永不转换（含 replace 掉 system head）+ 非法 surfaceOp 按追加处理", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "system/message", { turn: 1, step: 1, message: { id: "sys-1", role: "system", content: [{ type: "text", text: "旧提示词" }], source: { kind: "system-prompt" } } }),
      surface(1, "user/message", userData("u-1", [{ type: "text", text: "问题" }])),
      surface(2, "system/message", { turn: 1, step: 1, message: { id: "sys-2", role: "system", content: [{ type: "text", text: "新提示词" }], source: { kind: "system-prompt" } } }, { op: "replace", startSeq: 0, endSeq: 0 }),
      surface(3, "assistant/message", assistantData("a-1", [], { provider: "p", model: "m" }), { op: "append-x" }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages.map((message) => message.id)).toEqual(["u-1", "a-1"]);
    expect(conversion.report.droppedEvents["system/message"]).toBe(2);
    expect(conversion.report.warnings.some((warning) => warning.includes("surfaceOp 不是合法的 replace"))).toBe(true);
  });
});

describe("convertDshSession：v4 形态（读支持 v3/v4）", () => {
  /** 扫描 + 解码 fixture 里的 v4 会话（走真实 扫描/解码 路径，不手工造事件）。 */
  async function decodeV4(): Promise<{ header: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
    const entries = await scanDshSessions(FIXTURES);
    const entry = entries.find((item) => item.sessionId === V4_ID);
    expect(entry?.generation).toBe(4);
    expect(entry?.file).toBeDefined();
    const { header, events } = await decodeDshSessionFile({
      file: entry!.file!,
      generation: entry!.generation!,
      compressed: entry!.compressed!,
    });
    return { header, events };
  }

  it("v4 fixture：一等 tool 角色消息 → tool_result（toolCallId/isError 取 message 级）", async () => {
    const { header, events } = await decodeV4();
    const conversion = convertDshSession(header, events);
    expect(conversion.messages.map((message) => [message.id, message.role])).toEqual([
      ["m1", "user"],
      ["m2", "assistant"],
      ["m3", "tool"],
      ["m4", "assistant"],
      ["m5", "tool"],
    ]);
    expect(conversion.meta).toMatchObject({ cwd: "/tmp/v4", createdAt: iso(1_786_505_870_000) });
    // 内容块：v4 的 plugin: 前缀块（未知类型）记账丢弃，tool-call 照常映射
    expect(conversion.messages[1]!.content).toEqual([
      { type: "text", text: "我先读文件" },
      { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } },
    ]);
    // 结果块直挂（无 tool-result 包装）：toolCallId 取 message.toolCallId，isError 取 message.isError
    expect(conversion.messages[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "call-1", content: "file body", isError: false },
    ]);
    expect(conversion.messages[4]!.content).toEqual([
      { type: "tool_result", toolCallId: "call-2", content: "exit 1 [exit code: 1]", isError: true },
    ]);
    expect(conversion.report.counts).toMatchObject({ user: 1, assistant: 2, tool: 2, images: 0, imagesMissing: 0 });
    // v4 附加事件 / 工具生命周期事件一律丢弃 + 计数（含 plugin: 前缀块聚合为警告）
    expect(conversion.report.droppedEvents).toEqual({
      "permission/preset": 1,
      "sandbox/mode": 1,
      "session-log-deepseek/delivery-accepted": 1,
      "tool/call": 2,
    });
    expect(conversion.report.warnings.some((warning) => warning.includes("未映射的内容块类型 plugin:foo"))).toBe(true);
    expect(conversion.report.warnings).toHaveLength(1);
    expect(conversion.ledger).toBeUndefined();
  });
});

describe("convertDshSession：压缩映射", () => {
  /** 4 条 surface 历史（u1/a1/u2/a2），压缩遮蔽前两条。 */
  function history(): Array<Record<string, unknown>> {
    return [
      surface(0, "user/message", userData("u1", [{ type: "text", text: "问题一" }])),
      surface(1, "assistant/message", assistantData("a1", [{ type: "text", text: "回答一" }], { provider: "p", model: "m" })),
      surface(2, "user/message", userData("u2", [{ type: "text", text: "问题二" }])),
      surface(3, "assistant/message", assistantData("a2", [{ type: "text", text: "回答二" }], { provider: "p", model: "m" })),
    ];
  }

  it("compaction/summary → ledger.compacted 锚到 shadowed 区间最后一条消息", () => {
    const events = [
      ...history(),
      event(4, "compaction/start", { compactionId: "c1", turn: 2 }),
      event(5, "compaction/summary", {
        compactionId: "c1",
        summary: [{ type: "text", text: "摘要正文" }, { type: "text", text: "第二段" }],
        shadowedRange: { start: 0, end: 1 },
        shadowedSeqs: [0, 1],
        shadowedTokenCount: 10,
        provider: "p",
        model: "m",
        rawOutput: [],
      }),
      event(6, "compaction/end", { compactionId: "c1", turn: 2 }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.ledger).toEqual({
      compacted: {
        uptoIndex: 2,
        uptoMessageId: "a1",
        mode: "overview",
        summary: "摘要正文\n第二段",
        instructions: [],
        createdAt: iso(T0 + 5),
      },
    });
    // 压缩事件有 owc 产物（账本），不进丢弃账
    expect(conversion.report.droppedEvents["compaction/summary"]).toBeUndefined();
    expect(conversion.report.droppedEvents).toEqual({ "compaction/end": 1, "compaction/start": 1 });
  });

  it("真实形态：锚到 checkpoint 消息（shadowed 事件已被移出 surface）", () => {
    const events = [
      surface(0, "user/message", userData("u1", [{ type: "text", text: "问题一" }])),
      surface(1, "assistant/message", assistantData("a1", [{ type: "text", text: "回答一" }], { provider: "p", model: "m" })),
      event(2, "compaction/start", { compactionId: "c1", turn: 2 }),
      event(3, "compaction/summary", {
        compactionId: "c1",
        summary: [{ type: "text", text: "摘要正文" }],
        shadowedRange: { start: 0, end: 1 },
        shadowedSeqs: [0, 1],
        shadowedTokenCount: 10,
        provider: "p",
        model: "m",
      }),
      // checkpoint：替换掉 [0,1] 这段可见历史，并留在 surface 里（被遮蔽的事件不再出现在后续 surface）
      surface(4, "user/message", {
        ...userData("ckpt-1", [{ type: "text", text: "摘要正文" }]),
        source: { kind: "plugin", plugin: "compact", compactionId: "c1" },
      }, { op: "replace", startSeq: 0, endSeq: 1 }),
      event(5, "compaction/end", { compactionId: "c1", turn: 2 }),
      surface(6, "assistant/message", assistantData("a2", [{ type: "text", text: "压缩后续答" }], { provider: "p", model: "m" })),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    // shadowed 的 u1/a1 已被移出 surface（丢弃计数），只剩 checkpoint 与后续消息
    expect(conversion.messages.map((message) => message.id)).toEqual(["ckpt-1", "a2"]);
    expect(conversion.ledger).toEqual({
      compacted: {
        uptoIndex: 1,
        uptoMessageId: "ckpt-1",
        mode: "overview",
        summary: "摘要正文",
        instructions: [],
        createdAt: iso(T0 + 3),
      },
    });
    expect(conversion.report.warnings.some((warning) => warning.includes("放弃压缩映射"))).toBe(false);
  });

  it("中段压缩：checkpoint 原位替换 [2,3]，锚点下标按替换后的位置算", () => {
    const events = [
      ...history(),
      event(4, "compaction/summary", {
        compactionId: "c1",
        summary: [{ type: "text", text: "后段摘要" }],
        shadowedRange: { start: 2, end: 3 },
        shadowedSeqs: [2, 3],
        provider: "p",
        model: "m",
      }),
      surface(5, "user/message", {
        ...userData("ckpt-2", [{ type: "text", text: "后段摘要" }]),
        source: { kind: "compact-checkpoint", compactionId: "c1" },
      }, { op: "replace", startSeq: 2, endSeq: 3 }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    // u1,a1 保留；u2,a2 被 checkpoint 原位顶掉；消息下标 = 替换后的位置
    expect(conversion.messages.map((message) => message.id)).toEqual(["u1", "a1", "ckpt-2"]);
    expect(conversion.ledger?.compacted).toMatchObject({ uptoIndex: 3, uptoMessageId: "ckpt-2", summary: "后段摘要" });
  });

  it("v4 形态 checkpoint（kind=compact-checkpoint）同样可锚；compactionId 不匹配则回退失败", () => {
    /** 与上一用例同构，只换 checkpoint 的 source 形态 / compactionId。 */
    function events(checkpointSource: Record<string, unknown>): Array<Record<string, unknown>> {
      return [
        surface(0, "user/message", userData("u1", [{ type: "text", text: "问题一" }])),
        surface(1, "assistant/message", assistantData("a1", [{ type: "text", text: "回答一" }], { provider: "p", model: "m" })),
        event(2, "compaction/summary", {
          compactionId: "c1",
          summary: [{ type: "text", text: "摘要正文" }],
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          provider: "p",
          model: "m",
        }),
        surface(3, "user/message", {
          id: "ckpt-1",
          role: "user",
          content: [{ type: "text", text: "摘要正文" }],
          source: checkpointSource,
        }, { op: "replace", startSeq: 0, endSeq: 1 }),
      ];
    }
    const matched = convertDshSession(dshHeader(), events({ kind: "compact-checkpoint", compactionId: "c1" }));
    expect(matched.ledger?.compacted).toMatchObject({ uptoIndex: 1, uptoMessageId: "ckpt-1", summary: "摘要正文" });

    // compactionId 对不上：既不是本 summary 的 checkpoint，shadowed seqs 又已被移出 surface → 放弃映射
    const mismatched = convertDshSession(dshHeader(), events({ kind: "compact-checkpoint", compactionId: "other" }));
    expect(mismatched.ledger).toBeUndefined();
    expect(mismatched.report.warnings.some((warning) => warning.includes("放弃压缩映射"))).toBe(true);
  });

  it("只有 shadowedRange 时按闭区间兜底锚点；多条 summary 只取最后一条", () => {
    const events = [
      ...history(),
      event(4, "compaction/summary", { summary: [{ type: "text", text: "旧摘要" }], shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 } }),
      event(5, "compaction/summary", { summary: [{ type: "text", text: "新摘要" }], shadowedSeqs: [], shadowedRange: { start: 0, end: 3 } }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.ledger?.compacted).toMatchObject({ uptoIndex: 4, uptoMessageId: "a2", summary: "新摘要" });
    expect(conversion.report.warnings.some((warning) => warning.includes("只采用"))).toBe(true);
  });

  it("锚点落在非 surface 事件上 → 放弃压缩映射 + 警告", () => {
    const events = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "compaction/summary", { summary: [{ type: "text", text: "摘要" }], shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 } }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.ledger).toBeUndefined();
    expect(conversion.report.warnings.some((warning) => warning.includes("放弃压缩映射"))).toBe(true);
  });

  it("compaction/prune 一律丢弃 + 计数 + 警告，不产出账本", () => {
    const events = [
      ...history(),
      event(4, "compaction/prune", { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 5 }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.ledger).toBeUndefined();
    expect(conversion.report.droppedEvents["compaction/prune"]).toBe(1);
    expect(conversion.report.warnings.some((warning) => warning.includes("compaction/prune"))).toBe(true);
  });
});

describe("convertDshSession：内容块与配对校验降级", () => {
  it("arguments 非法 JSON → {_raw} 降级 + 警告", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "assistant/message", assistantData("a1", [
        { type: "tool-call", id: "c1", name: "read_file", arguments: "{不是 JSON" },
        { type: "tool-call", id: "c2", name: "grep", arguments: "\"just-a-string\"" },
      ], { provider: "p", model: "m" })),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages[0]!.content[0]).toEqual({ type: "tool_call", id: "c1", name: "read_file", input: { _raw: "{不是 JSON" } });
    expect(conversion.messages[0]!.content[1]).toEqual({ type: "tool_call", id: "c2", name: "grep", input: { _raw: "\"just-a-string\"" } });
    expect(conversion.report.warnings.filter((warning) => warning.includes("_raw"))).toHaveLength(2);
    // 孤儿 tool_call 保留不动（模型可感知中断）
    expect(conversion.messages[0]!.content).toHaveLength(2);
  });

  it("replayState 的 responses 形态（reasoning 的 item）也读入 thinking.signature；块上自带时优先", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "assistant/message", assistantData("a1", [
        { type: "reasoning", text: "想一下" },
        { type: "text", text: "答" },
      ], {
        provider: "p",
        model: "m",
        // openai-responses 的 replay 落点：reasoning 用 item 承载完整 item JSON（owc 侧存 signature）
        replayState: { response: { kind: "llm-service-lite-responses", version: 1 }, blocks: [{ type: "reasoning", item: "{\"type\":\"reasoning\",\"id\":\"rs_1\"}" }, { type: "text", itemId: "msg_1" }] },
      })),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages[0]!.content[0]).toEqual({
      type: "thinking",
      text: "想一下",
      provider: "p",
      signature: "{\"type\":\"reasoning\",\"id\":\"rs_1\"}",
    });

    // 块上自带 signature 时优先（anthropic 形态回放元数据里同时有 signature 也不覆盖块上的值）
    const onBlock = convertDshSession(dshHeader(), [
      surface(0, "assistant/message", assistantData("a1", [{ type: "reasoning", text: "x", signature: "block-sig" }], {
        provider: "p",
        model: "m",
        replayState: { response: { kind: "llm-service-lite-anthropic", version: 1 }, blocks: [{ type: "reasoning", signature: "replay-sig" }] },
      })),
    ]);
    expect((onBlock.messages[0]!.content[0] as { signature?: string }).signature).toBe("block-sig");
  });

  it("头行与首个事件都没有合法时间 → createdAt 回退 1970 并告警（不再静默）", () => {
    const conversion = convertDshSession({ cwd: "/tmp/x", createdAt: "not-a-number" }, [
      event(0, "user/message", { id: "m0", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }, { surfaceOp: "append", time: Number.NaN }),
    ]);
    expect(conversion.meta.createdAt).toBe(new Date(0).toISOString());
    expect(conversion.report.warnings.some((warning) => warning.includes("回退为 1970-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("孤儿 tool_result 降级为 user 角色的文本消息（前缀 [工具结果 <toolCallId>]，模型可见）", () => {
    const events: Array<Record<string, unknown>> = [
      event(0, "tool/call", { turn: 1, step: 1, callId: "gone", name: "bash", arguments: "{}" }),
      surface(1, "tool/result", toolResultData("t1", "gone", [{ type: "text", text: "exit 1" }], true)),
      surface(2, "tool/result", toolResultData("t2", "unknown-call", [{ type: "text", text: "结果正文" }])),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    // 角色也改：留在 role:'tool' 的纯文本块会被 provider 适配层吞掉（模型看不到），降级为 user 才可见
    expect(conversion.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(conversion.messages[0]!.content).toEqual([{ type: "text", text: "[工具结果 gone] exit 1" }]);
    expect(conversion.messages[1]!.content).toEqual([{ type: "text", text: "[工具结果 unknown-call] 结果正文" }]);
    expect(conversion.report.warnings.some((warning) => warning.includes("2 个孤儿 tool_result")
      && warning.includes("user 角色"))).toBe(true);
    // 计数如实挪位：两条结果消息不再计成 tool，改计 user
    expect(conversion.report.counts).toMatchObject({ user: 2, tool: 0 });
    // 配对成功的 tool_result 不受影响
    const paired = convertDshSession(dshHeader(), [
      surface(0, "assistant/message", assistantData("a1", [{ type: "tool-call", id: "c1", name: "read_file", arguments: "{}" }], { provider: "p", model: "m" })),
      surface(1, "tool/result", toolResultData("t1", "c1", [{ type: "text", text: "ok" }])),
    ]);
    expect(paired.messages[1]!.content).toEqual([{ type: "tool_result", toolCallId: "c1", content: "ok", isError: false }]);
    expect(paired.messages[1]!.role).toBe("tool");
    expect(paired.report.warnings).toEqual([]);
  });

  it("image/file 块降级为文本占位并计数（含 tool_result 内的图片）", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "user/message", userData("u1", [
        { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 3, width: 1, height: 1 } },
        { type: "file", attachment: { attachmentId: "att-2", name: "spec.pdf", bytes: 2048 } },
        { type: "tool-addition", tool: { name: "x" } },
      ])),
      surface(1, "assistant/message", assistantData("a1", [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }], { provider: "p", model: "m" })),
      surface(2, "tool/result", toolResultData("t1", "c1", [
        { type: "text", text: "图：" },
        { type: "image", attachment: { attachmentId: "att-3", mediaType: "image/jpeg", bytes: 9, width: 1, height: 1 } },
      ])),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.messages[0]!.content).toEqual([
      { type: "text", text: "[dsh 图片附件 att-1]" },
      { type: "text", text: "[dsh 文件附件 spec.pdf (2048B)]" },
    ]);
    expect(conversion.messages[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "c1", content: "图：\n[dsh 图片附件 att-3]", isError: false },
    ]);
    expect(conversion.report.counts).toMatchObject({ images: 2, imagesMissing: 2 });
    expect(conversion.report.warnings.some((warning) => warning.includes("图片附件本里程碑只做文本占位"))).toBe(true);
    expect(conversion.report.warnings.some((warning) => warning.includes("未映射的内容块类型 tool-addition"))).toBe(true);
  });
});

describe("convertDshSession：meta（title / provider 提示）", () => {
  it("session/title → messageSeqs 首个命中文本块截 120；未命中回退 title 字段", () => {
    const long = "长".repeat(200);
    const events: Array<Record<string, unknown>> = [
      surface(0, "user/message", userData("u1", [{ type: "text", text: long }])),
      event(1, "session/title", { title: "备用标题", messageSeqs: [0], source: "user" }),
      event(2, "request/header", { header: { config: { provider: "gateway", model: "gpt-x" }, adapterDefaults: { maxTokens: true } }, reason: "initial" }),
    ];
    const conversion = convertDshSession(dshHeader(), events);
    expect(conversion.meta.title).toBe("长".repeat(120));
    expect(conversion.meta.providerHint).toBe("gateway");
    expect(conversion.meta.modelHint).toBe("gpt-x");
    expect(conversion.report.droppedEvents["session/title"]).toBeUndefined();
    expect(conversion.report.droppedEvents["request/header"]).toBeUndefined();

    const fallback = convertDshSession(dshHeader(), [
      surface(0, "user/message", userData("u1", [{ type: "text", text: "正文" }])),
      event(1, "session/title", { title: "备用标题", messageSeqs: [99], source: "llm" }),
    ]);
    expect(fallback.meta.title).toBe("备用标题");
    expect(fallback.meta.providerHint).toBeUndefined();
  });

  it("header.createdAt 非法时回退首个事件 time 并记一次聚合警告", () => {
    const events: Array<Record<string, unknown>> = [
      surface(0, "user/message", userData("u1", [{ type: "text", text: "hi" }])),
      // time 非法（字符串）的事件：createdAt 回退会话 createdAt
      { type: "user/message", seq: 1, time: "not-a-number", data: userData("u2", [{ type: "text", text: "hi2" }]), surfaceOp: "append" },
    ];
    const conversion = convertDshSession({ ...dshHeader(), createdAt: undefined }, events);
    expect(conversion.meta.createdAt).toBe(iso(T0));
    expect(conversion.messages.map((message) => message.createdAt)).toEqual([iso(T0), iso(T0)]);
    expect(conversion.report.warnings.some((warning) => warning.includes("createdAt 回退"))).toBe(true);
  });
});

describe("SessionStore.replaceJsonl", () => {
  /** 格式与 importJsonl 一致的会话文本（首行 meta + 消息行）；extra 注入「应被净化」的脏字段。 */
  function sessionText(
    id: string,
    title: string,
    messages: Array<{ id: string; role: string; text: string; createdAt: string }>,
    extra: Record<string, unknown> = {},
  ): string {
    const head = {
      kind: "meta",
      version: 1,
      exportedAt: iso(T0),
      session: {
        id,
        cwd: "/dsh/project",
        provider: "dsh-provider",
        model: "dsh-model",
        title,
        createdAt: iso(T0),
        updatedAt: iso(T0),
        ...extra,
      },
    };
    const lines = messages.map((message) => JSON.stringify({
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.text }],
      createdAt: message.createdAt,
    }));
    return `${[JSON.stringify(head), ...lines].join("\n")}\n`;
  }

  /** 先 importJsonl 建会话（沿用给定 id），再补权限/沙盒配置与账本。 */
  async function seededSession(): Promise<{ store: SessionStore; sessionId: string; sessionDir: string }> {
    const root = await tempRoot("dsh-sync-replace-");
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const sessionId = randomUUID();
    const created = await store.importJsonl(sessionText(sessionId, "旧标题", [
      { id: "old-1", role: "user", text: "旧历史", createdAt: iso(T0) },
    ]));
    expect(created.id).toBe(sessionId);
    await store.updatePermissions(sessionId, "yolo", [{ tool: "bash" }]);
    await store.updateSandboxMode(sessionId, "off", "echo setup");
    const sessionDir = path.join(root, "sessions", sessionId);
    await new ContextManager(sessionDir).replaceLedger({
      compacted: { uptoIndex: 1, uptoMessageId: "old-1", mode: "overview", summary: "旧摘要", instructions: [], createdAt: iso(T0) },
    });
    expect(JSON.parse(await readFile(path.join(sessionDir, "ledger.json"), "utf8")).compacted.uptoMessageId).toBe("old-1");
    return { store, sessionId, sessionDir };
  }

  it("替换历史：覆盖 title/createdAt + 备份 + 删 ledger + 保留原 cwd/沙盒/权限配置", async () => {
    const { store, sessionId, sessionDir } = await seededSession();
    const dirty = {
      permissionMode: "yolo",
      permissionRules: [{ tool: "*" }],
      sandbox: { enabled: false, readRoots: ["/"], writeRoots: ["/"], denyPaths: [], network: "allow" },
      sandboxMode: "wsb",
      setupScript: "rm -rf /",
      workspace: { mode: "managed", backend: "overlayfs", originCwd: "/", image: "x", mountPoint: "y" },
    };
    const meta = await store.replaceJsonl(sessionId, sessionText(sessionId, "dsh 导入会话", [
      { id: "n1", role: "user", text: "新历史一", createdAt: "2024-01-01T00:00:01.000Z" },
      { id: "n2", role: "assistant", text: "新历史二", createdAt: "2024-01-01T00:00:02.000Z" },
    ], dirty));

    expect(meta.id).toBe(sessionId);
    expect(meta.title).toBe("dsh 导入会话");
    expect(meta.createdAt).toBe(iso(T0));
    expect(meta.updatedAt >= "2024-01-01T00:00:00.000Z").toBe(true);
    // 原会话配置保留：导入文件里的沙盒/权限/工作区字段一律不吸收
    expect(meta.cwd).toBe("/dsh/project");
    expect(meta.provider).toBe("dsh-provider");
    expect(meta.model).toBe("dsh-model");
    expect(meta.permissionMode).toBe("yolo");
    expect(meta.permissionRules).toEqual([{ tool: "bash" }]);
    expect(meta.sandboxMode).toBe("off");
    expect(meta.setupScript).toBe("echo setup");
    expect(meta.workspace).toBeUndefined();

    const detail = await store.get(sessionId);
    expect(detail?.messages.map((message) => [message.id, message.role, message.createdAt])).toEqual([
      ["n1", "user", "2024-01-01T00:00:01.000Z"],
      ["n2", "assistant", "2024-01-01T00:00:02.000Z"],
    ]);
    expect(await readdir(sessionDir)).toEqual(expect.arrayContaining([expect.stringMatching(/^messages\.jsonl\.upgrade-/)]));
    await expect(stat(path.join(sessionDir, "ledger.json"))).rejects.toThrow();
  });

  it("目标会话不存在 → 抛「会话不存在」；空文本 → 抛导入校验错误", async () => {
    const { store, sessionId } = await seededSession();
    const missing = randomUUID();
    await expect(store.replaceJsonl(missing, sessionText(missing, "不存在", []))).rejects.toThrow("会话不存在");
    await expect(store.replaceJsonl(sessionId, "  ")).rejects.toThrow("导入内容为空");
  });
});

describe("server API：sessions.import（经 ExtensionManager 分发）", () => {
  /** 白盒构造：注入真实 SessionStore，跳过 initialize（不 fork 宿主进程）。 */
  async function buildManager(): Promise<{
    dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>;
    store: SessionStore;
    sessionId: string;
    dataDir: string;
  }> {
    const root = await tempRoot("dsh-sync-import-api-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const store = new SessionStore(path.join(dataDir, "sessions"));
    await store.initialize();
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m", title: "旧标题" })).id;
    await store.appendMessage(sessionId, "user", [{ type: "text", text: "旧历史" }]);
    const manager = new ExtensionManager(dataDir, undefined, { sessions: store });
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无新权限", apiVersion: "1", permissions: [] },
    ];
    return {
      dataDir,
      store,
      sessionId,
      dispatch: (request) => (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request),
    };
  }

  /** 导入文本（首行 meta + 消息行）。 */
  function text(id: string, title: string): string {
    const head = { kind: "meta", version: 1, exportedAt: iso(T0), session: { id, cwd: "/tmp/dsh", provider: "p", model: "m", title, createdAt: iso(T0), updatedAt: iso(T0) } };
    return `${[JSON.stringify(head), JSON.stringify({ id: `${id}-m1`, role: "user", content: [{ type: "text", text: "导入的消息" }], createdAt: iso(T0) })].join("\n")}\n`;
  }

  /** 转换器产出的账本形状（M3a 转换模块的 ledger 字段）。 */
  const ledger = {
    compacted: { uptoIndex: 1, uptoMessageId: "dsh-0", mode: "overview", summary: "摘要", instructions: [], createdAt: iso(T0) },
  };

  it("无 sessions:mutate 权限的扩展被拒", async () => {
    const { dispatch, sessionId } = await buildManager();
    await expect(dispatch({ id: "1", api: "sessions.import", extensionId: "third-party", params: { text: text("x", "t"), replaceId: sessionId } }))
      .rejects.toThrow("lacks permission: sessions:mutate");
  });

  it("replaceId：覆盖目标会话并把可选 ledger 落盘", async () => {
    const { dispatch, store, sessionId } = await buildManager();
    const result = await dispatch({
      id: "2",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { text: text(sessionId, "dsh 覆盖"), replaceId: sessionId, ledger },
    }) as Record<string, unknown>;
    expect(result.id).toBe(sessionId);
    expect(result.title).toBe("dsh 覆盖");
    expect((await store.get(sessionId))?.messages.map((message) => message.id)).toEqual([`${sessionId}-m1`]);
    const written = JSON.parse(await readFile(path.join(store.contextRoot(sessionId), "ledger.json"), "utf8")) as { compacted?: { uptoMessageId?: string } };
    expect(written.compacted?.uptoMessageId).toBe("dsh-0");
  });

  it("无 replaceId：新建导入（原 id 被占用 → 分配新会话）并落账本", async () => {
    const { dispatch, store, sessionId } = await buildManager();
    const result = await dispatch({
      id: "3",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { text: text(sessionId, "dsh 新建"), ledger },
    }) as Record<string, unknown>;
    expect(result.id).not.toBe(sessionId);
    const created = String(result.id);
    expect((await store.get(created))?.messages.map((message) => message.id)).toEqual([`${sessionId}-m1`]);
    expect(JSON.parse(await readFile(path.join(store.contextRoot(created), "ledger.json"), "utf8")).compacted.uptoMessageId).toBe("dsh-0");
    // 原会话不受影响
    expect((await store.get(sessionId))?.title).toBe("旧标题");
  });

  it("空文本 / 非对象 ledger 的边界：空文本报错，ledger 缺省时不落账本文件", async () => {
    const { dispatch, store, sessionId } = await buildManager();
    await expect(dispatch({ id: "4", api: "sessions.import", extensionId: "dsh-sync", params: { text: "", replaceId: sessionId } }))
      .rejects.toThrow("requires non-empty text");
    await expect(dispatch({ id: "5", api: "sessions.import", extensionId: "dsh-sync", params: { text: text(sessionId, "无账本"), replaceId: sessionId } }))
      .resolves.toMatchObject({ title: "无账本" });
    await expect(stat(path.join(store.contextRoot(sessionId), "ledger.json"))).rejects.toThrow();
  });
});

describe("dsh-sync manifest：权限与版本声明", () => {
  it("声明 sessions:read / sessions:mutate 且版本推进到 0.3.0（回放元数据 / 媒体导出 / 嵌套子代理）", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    expect(manifest?.version).toBe("0.3.0");
    expect(manifest?.permissions).toEqual(expect.arrayContaining(["sessions:read", "sessions:mutate"]));
  });
});

describe("server API：models.defaultSelection（白盒分发）", () => {
  /**
   * 建带 `resolveModelSelection` 桩的 manager：桩记录收到的 provider（undefined = 默认链），
   * 供断言「给了 provider 走 provider 分支 / 不给走默认链」。
   */
  async function buildSelectionManager(
    stub?: (provider?: string) => { provider?: string; model?: string } | undefined,
  ): Promise<{ dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>; calls: Array<string | undefined> }> {
    const root = await tempRoot("dsh-sync-selection-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const calls: Array<string | undefined> = [];
    const manager = new ExtensionManager(dataDir, undefined, {
      ...(stub === undefined ? {} : { resolveModelSelection: (provider?: string) => { calls.push(provider); return stub(provider); } }),
    });
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无新权限", apiVersion: "1", permissions: [] },
    ];
    return {
      calls,
      dispatch: (request) => (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request),
    };
  }

  it("给 provider：只解析该 provider 的默认模型（桩收到 provider，不回落到默认链）", async () => {
    const { dispatch, calls } = await buildSelectionManager((provider) =>
      (provider === "demo" ? { provider: "demo", model: "demo-default" } : { provider: "other", model: "other-default" }));
    await expect(dispatch({ id: "1", api: "models.defaultSelection", extensionId: "dsh-sync", params: { provider: "demo" } }))
      .resolves.toEqual({ provider: "demo", model: "demo-default" });
    expect(calls).toEqual(["demo"]);
  });

  it("不给 provider：走默认链；空串 provider 视同不给（退回默认链）", async () => {
    const { dispatch, calls } = await buildSelectionManager(() => ({ provider: "demo", model: "demo-default" }));
    await expect(dispatch({ id: "1", api: "models.defaultSelection", extensionId: "dsh-sync" }))
      .resolves.toEqual({ provider: "demo", model: "demo-default" });
    await expect(dispatch({ id: "2", api: "models.defaultSelection", extensionId: "dsh-sync", params: { provider: "" } }))
      .resolves.toEqual({ provider: "demo", model: "demo-default" });
    expect(calls).toEqual([undefined, undefined]);
  });

  it("私有只读元信息：无需权限（第三方扩展可调），未接线时回空对象", async () => {
    const withStub = await buildSelectionManager(() => ({ provider: "demo", model: "demo-default" }));
    await expect(withStub.dispatch({ id: "1", api: "models.defaultSelection", extensionId: "third-party" }))
      .resolves.toEqual({ provider: "demo", model: "demo-default" });
    // 桩也没接（server 未配置默认解析）时回空对象，由调用方按「补不出来」处理
    const noStub = await buildSelectionManager();
    await expect(noStub.dispatch({ id: "2", api: "models.defaultSelection", extensionId: "third-party" }))
      .resolves.toEqual({});
  });
});

describe("readManifest 允许新权限（第三方扩展）", () => {
  it("sessions:mutate 通过权限白名单校验", async () => {
    const root = await tempRoot("dsh-sync-manifest-");
    // 第三方扩展目录约定：<dataDir>/extensions/owc-ext-<id>
    const directory = path.join(root, "extensions", "owc-ext-third-party");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      id: "third-party",
      name: "第三方",
      version: "0.0.1",
      description: "声明 sessions:mutate",
      apiVersion: "1",
      permissions: ["sessions:read", "sessions:mutate"],
    }), "utf8");
    const manager = new ExtensionManager(root, undefined, {});
    const discovered = await (manager as unknown as { discoverThirdParty(): Promise<ExtensionManifest[]> }).discoverThirdParty();
    expect(discovered.map((manifest) => manifest.id)).toEqual(["third-party"]);
  });
});
