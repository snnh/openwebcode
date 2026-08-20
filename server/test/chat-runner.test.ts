import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry, type ProviderEvent, type StreamChatRequest } from "../src/providers/provider.js";
import type { ChatMessage, MessageContent } from "../src/sessions/types.js";
import type { ChatAssistantStore } from "../src/chat/chat-assistant-store.js";
import type { ChatConfigService } from "../src/chat/chat-config.js";
import type { ChatConfig } from "../src/chat/chat-types.js";
import type { ChatPythonEnv } from "../src/chat/chat-python-env.js";
import { ChatRunner } from "../src/chat/chat-runner.js";
import type { ChatSessionStore } from "../src/chat/chat-session-store.js";
import type { ChatAssistant, ChatSessionMeta } from "../src/chat/chat-types.js";
import { makeStubProvider } from "./helpers/stub-provider.js";

// python 工具的真实实现会 spawn uv 环境；这里替换为只上抛 onPythonStatus 的假实现，
// 其余工具（calculate 等）保留真实逻辑供轮次循环使用。
vi.mock("../src/chat/chat-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat/chat-tools.js")>();
  return {
    ...actual,
    chatTools: () => actual.chatTools().map((tool) =>
      tool.name === "python"
        ? {
            ...tool,
            requiresSandbox: false,
            handler: async (_input: Record<string, unknown>, ctx: unknown) => {
              (ctx as { onPythonStatus?: (status: string, detail?: string) => void })
                .onPythonStatus?.("preparing", "venv");
              return [{ type: "text" as const, text: "ok" }];
            },
          }
        : tool),
  };
});

/** 内存版会话存储：记录 appendMessage 落盘内容，供父链与落盘断言。 */
class FakeChatSessionStore {
  readonly messages: ChatMessage[] = [];
  private seq = 0;

  async getMessages(_id: string): Promise<ChatMessage[]> {
    return [...this.messages];
  }

  async appendMessage(
    _id: string,
    role: "user" | "assistant" | "tool",
    content: MessageContent[],
    lineage?: { parentId?: string; runId?: string },
  ): Promise<ChatMessage> {
    this.seq += 1;
    const message: ChatMessage = {
      id: `m${this.seq}`,
      role,
      content,
      createdAt: new Date().toISOString(),
      ...(lineage?.parentId ? { parentId: lineage.parentId } : {}),
      ...(lineage?.runId ? { runId: lineage.runId } : {}),
    };
    this.messages.push(message);
    return message;
  }

  sessionDir(id: string): string {
    return `fake-chat-sessions/${id}`;
  }
}

function textOf(message: ChatMessage): string {
  const block = message.content.find((c) => c.type === "text");
  return block?.type === "text" ? block.text : "";
}

function meta(overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta {
  return {
    id: "s1",
    title: "测试会话",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    provider: "stub",
    model: "stub-model",
    ...overrides,
  };
}

type Handler = (request: StreamChatRequest) => AsyncIterable<ProviderEvent>;

const defaultHandler: Handler = (request) => (async function* () {
  request.signal.throwIfAborted();
  yield { type: "text_delta", text: "答" };
  yield { type: "done", stopReason: "end_turn" as const };
})();

/** 流出一段文本后挂起，直到 signal 中止（用于 stop/并发用例）。 */
const hangUntilAbort: Handler = (request) => (async function* () {
  yield { type: "text_delta", text: "部分" };
  await new Promise<never>((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
})();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeRunner(options: {
  store?: FakeChatSessionStore;
  handler?: Handler;
  assistant?: ChatAssistant;
  maxTurns?: number;
  chatConfig?: ChatConfig;
} = {}) {
  const store = options.store ?? new FakeChatSessionStore();
  const registry = new ProviderRegistry();
  const requests: StreamChatRequest[] = [];
  registry.register(makeStubProvider("stub", (request) => {
    // 快照：runner 复用同一 messages 数组跨轮追加，直接存引用会看到后续轮的消息
    requests.push({ ...request, messages: [...request.messages] });
    return (options.handler ?? defaultHandler)(request);
  }));
  const assistantStore = {
    get: async (_id: string) => options.assistant,
  } as unknown as ChatAssistantStore;
  const chatConfig = {
    get: () => Promise.resolve(options.chatConfig ?? {}),
  } as ChatConfigService;
  const runner = new ChatRunner(
    store as unknown as ChatSessionStore,
    registry,
    {} as ChatPythonEnv,
    undefined,
    undefined,
    chatConfig,
    undefined,
    assistantStore,
    () => options.maxTurns ?? 10,
  );
  return { runner, store, requests, registry };
}

function runParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    userMessage: "第一句",
    meta: meta(),
    signal: new AbortController().signal,
    onDelta: () => undefined,
    ...overrides,
  };
}

describe("ChatRunner", () => {
  it("多轮历史组装：第二轮起 provider 请求含上一轮 user+assistant", async () => {
    const { runner, store, requests } = makeRunner();
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);
    await runner.runChatMessage(runParams());

    const a1 = store.messages.at(-1)!;
    await store.appendMessage("s1", "user", [{ type: "text", text: "第二句" }], { parentId: a1.id });
    const u2 = store.messages.at(-1)!;
    await runner.runChatMessage(runParams({
      userMessage: "第二句",
      meta: meta({ activeLeafId: u2.id }),
    }));

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map(textOf)).toEqual(["第一句", "答", "第二句"]);
  });

  it("活动路径按 meta.activeLeafId 裁剪：只带所选分支", async () => {
    const { runner, store, requests } = makeRunner();
    const u1 = await store.appendMessage("s1", "user", [{ type: "text", text: "问" }]);
    const a1 = await store.appendMessage("s1", "assistant", [{ type: "text", text: "答" }], { parentId: u1.id });
    await store.appendMessage("s1", "user", [{ type: "text", text: "旧分支" }], { parentId: a1.id });
    const u2b = await store.appendMessage("s1", "user", [{ type: "text", text: "新分支" }], { parentId: a1.id });

    await runner.runChatMessage(runParams({
      userMessage: "新分支",
      meta: meta({ activeLeafId: u2b.id }),
    }));

    const texts = requests[0]!.messages.map(textOf);
    expect(texts).toEqual(["问", "答", "新分支"]);
    expect(texts).not.toContain("旧分支");
  });

  it("并发第二跑在首个 await 前同步抛 already running，首跑完成后可再跑", async () => {
    const gate = deferred();
    const gated: Handler = (_request) => (async function* () {
      yield { type: "text_delta", text: "流式中" };
      await gate.promise;
      yield { type: "done", stopReason: "end_turn" as const };
    })();
    const { runner, store } = makeRunner({ handler: gated });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);

    const first = runner.runChatMessage(runParams());
    await expect(runner.runChatMessage(runParams())).rejects.toThrow(/already running/);
    expect(runner.isRunning("s1")).toBe(true);

    gate.resolve();
    const result = await first;
    expect(result.stopReason).toBe("end_turn");
    expect(runner.isRunning("s1")).toBe(false);

    // 同一会话在首跑结束后可以再次运行（finally 正确清理）
    await store.appendMessage("s1", "user", [{ type: "text", text: "第二句" }]);
    await expect(runner.runChatMessage(runParams({ userMessage: "第二句" }))).resolves.toBeDefined();
  });

  it("stop：发 stopped 回调且部分 assistant 文本按父链落盘，不按错误上抛", async () => {
    const { runner, store } = makeRunner({ handler: hangUntilAbort });
    const user = await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);
    const deltas: string[] = [];
    let stoppedCalls = 0;

    const run = runner.runChatMessage(runParams({
      onDelta: (text: string) => deltas.push(text),
      onStopped: () => { stoppedCalls += 1; },
    }));
    await vi.waitFor(() => expect(deltas).toEqual(["部分"]));

    runner.stopChatMessage("s1");
    const result = await run;

    expect(result.stopReason).toBe("stopped");
    expect(stoppedCalls).toBe(1);
    expect(result.assistantContent).toEqual([{ type: "text", text: "部分" }]);
    const assistant = store.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "部分" }]);
    expect(assistant?.parentId).toBe(user.id);
    expect(runner.isRunning("s1")).toBe(false);
  });

  it("maxTurns 耗尽：以 stopReason max_turns 收尾", async () => {
    const loopTool: Handler = () => (async function* () {
      yield { type: "tool_call", id: "call-1", name: "calculate", input: { expression: "1+1" } };
      yield { type: "done", stopReason: "tool_use" as const };
    })();
    const { runner, store, requests } = makeRunner({ handler: loopTool, maxTurns: 2 });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);

    const result = await runner.runChatMessage(runParams({ meta: meta({ enabledTools: ["calculate"] }) }));

    expect(result.stopReason).toBe("max_turns");
    expect(requests).toHaveLength(2);
    // 每轮 assistant（tool_call）+ tool 结果各落盘一次
    expect(store.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(store.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("助手预设的 temperature/topP 下发到 provider 请求", async () => {
    const assistant: ChatAssistant = {
      id: "asst",
      name: "采样助手",
      systemPrompt: "预设提示",
      temperature: 0.7,
      topP: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { runner, store, requests } = makeRunner({ assistant });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);

    await runner.runChatMessage(runParams({ meta: meta({ assistantId: "asst" }) }));

    expect(requests[0]!.temperature).toBe(0.7);
    expect(requests[0]!.topP).toBe(0.9);
    expect(requests[0]!.system).toBe("预设提示");
  });

  it("onPythonStatus 由工具上下文转发（python_status 通道）", async () => {
    const pythonTurn: Handler = (request) => (async function* () {
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" as const };
        return;
      }
      yield { type: "tool_call", id: "call-1", name: "python", input: { code: "print(1)" } };
      yield { type: "done", stopReason: "tool_use" as const };
    })();
    const { runner, store } = makeRunner({ handler: pythonTurn });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);
    const statuses: [string, string | undefined][] = [];

    const result = await runner.runChatMessage(runParams({
      meta: meta({ enabledTools: ["python"] }),
      onPythonStatus: (status: string, detail?: string) => statuses.push([status, detail]),
    }));

    expect(result.stopReason).toBe("end_turn");
    expect(statuses).toEqual([["preparing", "venv"]]);
  });

  it("thinking_delta/thinking_end 累积为带 provider 的 thinking 块，随 assistant 消息落盘并回填上下文", async () => {
    const thinkingTurn: Handler = (request) => (async function* () {
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" as const };
        return;
      }
      // 分片式思考流 + 工具调用（DeepSeek 思维模式场景：回传素材必须落盘）
      yield { type: "thinking_delta", text: "先分" };
      yield { type: "thinking_delta", text: "析" };
      yield { type: "thinking_end", text: "先分析" };
      yield { type: "tool_call", id: "call-1", name: "calculate", input: { expression: "1+1" } };
      yield { type: "done", stopReason: "tool_use" as const };
    })();
    const { runner, store, requests } = makeRunner({ handler: thinkingTurn });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);

    const result = await runner.runChatMessage(runParams({ meta: meta({ enabledTools: ["calculate"] }) }));

    expect(result.stopReason).toBe("end_turn");
    // 落盘 assistant 消息：thinking 分片合并为单块，带 provider 同源标记
    const assistant = store.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", text: "先分析", provider: "stub" },
      { type: "tool_call", id: "call-1", name: "calculate", input: { expression: "1+1" } },
    ]);
    // 第二轮 provider 请求的 messages 已含 thinking 块（回填进内存上下文）
    expect(requests).toHaveLength(2);
    const secondAssistant = requests[1]!.messages.find((message) => message.role === "assistant");
    expect(secondAssistant?.content).toEqual([
      { type: "thinking", text: "先分析", provider: "stub" },
      { type: "tool_call", id: "call-1", name: "calculate", input: { expression: "1+1" } },
    ]);
  });

  it("thinking_delta 经 onThinkingDelta 实时上抛（SSE 流式通道）", async () => {
    const thinkingTurn: Handler = () => (async function* () {
      yield { type: "thinking_delta", text: "先想" };
      yield { type: "thinking_delta", text: "一下" };
      yield { type: "text_delta", text: "答" };
      yield { type: "done", stopReason: "end_turn" as const };
    })();
    const { runner, store } = makeRunner({ handler: thinkingTurn });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);
    const thinkingDeltas: string[] = [];

    const result = await runner.runChatMessage(runParams({
      onThinkingDelta: (text: string) => thinkingDeltas.push(text),
    }));

    expect(result.stopReason).toBe("end_turn");
    expect(thinkingDeltas).toEqual(["先想", "一下"]);
  });

  it("text_end 以权威文本 + v1 textSignature 固化文本块，不与 currentTurnText 重复追加", async () => {
    const textTurn: Handler = () => (async function* () {
      yield { type: "text_delta", text: "部分" };
      yield { type: "text_end", text: "完成", signature: JSON.stringify({ v: 1, id: "msg_c1", phase: "final_answer" }) };
      yield { type: "done", stopReason: "end_turn" as const };
    })();
    const { runner, store } = makeRunner({ handler: textTurn });
    await store.appendMessage("s1", "user", [{ type: "text", text: "第一句" }]);

    const result = await runner.runChatMessage(runParams());

    expect(result.stopReason).toBe("end_turn");
    const assistant = store.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "text", text: "完成", textSignature: JSON.stringify({ v: 1, id: "msg_c1", phase: "final_answer" }) },
    ]);
  });
});
