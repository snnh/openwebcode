import { describe, expect, it } from "vitest";
import { buildRenderItems, collectProducedFiles, insertCompactionMarkers, insertProducedFiles, isProcess, turnOf } from "../chat/message-groups";
import type { ChatMessage, MessageContent } from "../lib/contracts";

function msg(id: string, role: ChatMessage["role"], content: MessageContent[]): ChatMessage {
  return { id, role, content, createdAt: "2026-08-01T00:00:00.000Z" };
}

const text = (value: string): MessageContent => ({ type: "text", text: value });

describe("turnOf", () => {
  it("user 消息开启一轮，其后的 assistant/tool 归属该轮，首条 user 前为 0", () => {
    const messages = [
      msg("a0", "assistant", [text("开场白")]),
      msg("u1", "user", [text("第一问")]),
      msg("a1", "assistant", [text("答一")]),
      msg("t1", "tool", [{ type: "tool_result", content: "ok" }]),
      msg("u2", "user", [text("第二问")]),
      msg("a2", "assistant", [text("答二")]),
    ];
    expect(turnOf(messages)).toEqual([0, 1, 1, 1, 2, 2]);
    expect(turnOf([])).toEqual([]);
  });
});

describe("isProcess", () => {
  it("tool 消息与无正文 text 块的 assistant 消息为过程消息", () => {
    const messages = [
      msg("u", "user", [text("问")]),
      msg("a-text", "assistant", [text("正式回复")]),
      msg("a-think", "assistant", [{ type: "thinking", text: "想一下" }]),
      msg("a-tool", "assistant", [{ type: "tool_call", id: "c1", name: "glob" }]),
      msg("a-blank", "assistant", [text("   ")]),
      msg("t", "tool", [{ type: "tool_result", toolCallId: "c1", content: "x" }]),
    ];
    expect(isProcess(messages)).toEqual([false, false, true, true, true, true]);
  });
});

describe("buildRenderItems", () => {
  const messages = [
    msg("u1", "user", [text("问")]),
    msg("a1", "assistant", [{ type: "tool_call", id: "c1", name: "read_file" }]),
    msg("t1", "tool", [{ type: "tool_result", toolCallId: "c1", content: "ok" }]),
    msg("a2", "assistant", [{ type: "tool_call", id: "c2", name: "edit_file" }, { type: "tool_call", id: "c3", name: "bash" }]),
    msg("t2", "tool", [{ type: "tool_result", toolCallId: "c2", content: "bad", isError: true }]),
    msg("a3", "assistant", [text("完成")]),
    msg("u2", "user", [text("再问")]),
    msg("a4", "assistant", [text("再答")]),
  ];

  it("foldProcess=true：连续过程段合并为一个 fold，统计工具调用数与失败标记", () => {
    const items = buildRenderItems(messages, { foldProcess: true });
    expect(items).toEqual([
      { kind: "message", index: 0, showDivider: true },
      { kind: "fold", start: 1, end: 5, toolCalls: 3, failed: true },
      { kind: "message", index: 5, showDivider: true },
      { kind: "message", index: 6, showDivider: true },
      { kind: "message", index: 7, showDivider: true },
    ]);
  });

  it("foldProcess=false（运行中）：过程消息不折叠，逐条渲染", () => {
    const items = buildRenderItems(messages, { foldProcess: false });
    expect(items.every((item) => item.kind === "message")).toBe(true);
    expect(items).toHaveLength(messages.length);
  });

  it("无失败工具结果的段 failed=false；纯 thinking 段 toolCalls=0", () => {
    const items = buildRenderItems(
      [msg("a", "assistant", [{ type: "thinking", text: "嗯" }]), msg("t", "tool", [{ type: "tool_result", content: "ok" }])],
      { foldProcess: true },
    );
    expect(items).toEqual([{ kind: "fold", start: 0, end: 2, toolCalls: 0, failed: false }]);
  });

  it("clear 分隔线边界：clearedLocal 不改变分组；分隔线外置/抑制由调用方按 showDivider 与段边界处理", () => {
    // clearedLocal 落在 fold 段首（分页窗口从过程段起步）：分组不变，调用方把分隔线外置到 fold 之前
    const items = buildRenderItems(messages, { foldProcess: true, clearedLocal: 1 });
    const fold = items.find((item) => item.kind === "fold");
    expect(fold).toMatchObject({ start: 1 });
    // 顶层 message 条目始终允许渲染分隔线（clearedLocal === index 时）
    for (const item of items) {
      if (item.kind === "message") expect(item.showDivider).toBe(true);
    }
  });

  it("空消息列表返回空数组", () => {
    expect(buildRenderItems([], { foldProcess: true })).toEqual([]);
  });
});

describe("insertProducedFiles / collectProducedFiles", () => {
  const writeCall = (path: string, id = "w1"): MessageContent => ({ type: "tool_call", id, name: "write_file", input: { path, content: "x" } });
  const editCall = (path: string, id = "e1"): MessageContent => ({ type: "tool_call", id, name: "edit_file", input: { path, oldText: "a", newText: "b" } });

  it("collectProducedFiles：write/edit 按 path 去重保持出现序，其他工具忽略", () => {
    const files = collectProducedFiles([
      writeCall("src/a.ts", "1"),
      editCall("src/b.ts", "2"),
      writeCall("src/a.ts", "3"), // 同 path 去重（保留先出现的 write）
      { type: "tool_call", id: "4", name: "read_file", input: { path: "src/c.ts" } },
      { type: "tool_call", id: "5", name: "bash", input: { command: "ls" } },
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", action: "write" },
      { path: "src/b.ts", action: "edit" },
    ]);
  });

  it("轮末插入：行落在本轮最后条目之后、下一轮 user 消息之前；折叠段后", () => {
    const conversation = [
      msg("u1", "user", [{ type: "text", text: "开始" }]),
      msg("a1", "assistant", [writeCall("src/a.ts")]),
      msg("t1", "tool", [{ type: "tool_result", toolCallId: "w1", content: "ok" }]),
      msg("a2", "assistant", [{ type: "text", text: "完成" }]),
      msg("u2", "user", [{ type: "text", text: "继续" }]),
      msg("a3", "assistant", [editCall("src/b.ts")]),
    ];
    const items = insertProducedFiles(buildRenderItems(conversation, { foldProcess: true }), conversation);
    expect(items.map((item) => item.kind)).toEqual(["message", "fold", "message", "files", "message", "fold", "files"]);
    const first = items[3]!;
    const second = items[6]!;
    expect(first).toMatchObject({ turn: 1, files: [{ path: "src/a.ts", action: "write" }] });
    expect(second).toMatchObject({ turn: 2, files: [{ path: "src/b.ts", action: "edit" }] });
  });

  it("跨消息同轮去重；无产出轮与 turn 0 不插入", () => {
    const conversation = [
      msg("a0", "assistant", [{ type: "text", text: "开场白" }]), // turn 0
      msg("u1", "user", [{ type: "text", text: "改" }]),
      msg("a1", "assistant", [writeCall("src/a.ts", "1")]),
      msg("a2", "assistant", [editCall("src/a.ts", "2")]), // 同 path 跨消息去重
      msg("u2", "user", [{ type: "text", text: "问" }]),
      msg("a3", "assistant", [{ type: "text", text: "答" }]), // 无产出
    ];
    const items = insertProducedFiles(buildRenderItems(conversation, { foldProcess: false }), conversation);
    const filesItems = items.filter((item) => item.kind === "files");
    expect(filesItems).toHaveLength(1);
    expect(filesItems[0]).toMatchObject({ turn: 1, files: [{ path: "src/a.ts", action: "write" }] });
  });

  it("与压缩检查点共存：检查点行不打断轮归属（在其后仍正确出 files 行）", () => {
    const conversation = [
      msg("u1", "user", [{ type: "text", text: "开始" }]),
      msg("a1", "assistant", [writeCall("src/a.ts")]),
    ];
    const marker = { id: "c1", uptoIndex: 1, mode: "overview", forced: false, createdAt: "2026-08-01T00:00:00.000Z", status: "settled" } as const;
    const base = buildRenderItems(conversation, { foldProcess: true });
    const withMarkers = insertCompactionMarkers(base, [{ position: 1, marker }], conversation.length);
    const items = insertProducedFiles(withMarkers, conversation);
    expect(items.map((item) => item.kind)).toEqual(["message", "compaction", "fold", "files"]);
  });
});
