// ChatMessageList：用户消息编辑重发（edit 路由长新分支）与「回到底部」浮钮。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList } from "../ChatMessageList";
import type { ChatMessage } from "../types";

// SSE 打桩：连接即静默（不推帧），只验证组件自身行为
class StubEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: [{ type: "text", text: "原始问题" }],
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as ChatMessage;
}

interface MockReply { status: number; body?: unknown }

function mockFetch(handler: (url: string, init?: RequestInit) => MockReply) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = handler(String(input), init);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const TWO_MESSAGES = [
  makeMessage({ id: "u1", role: "user" }),
  makeMessage({ id: "a1", role: "assistant", content: [{ type: "text", text: "旧回答" }] }),
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(messageList: ChatMessage[] = TWO_MESSAGES) {
  vi.stubGlobal("EventSource", StubEventSource);
  const fetchMock = mockFetch((url, init) => {
    if (url.endsWith(`/api/chat/sessions/s1`) && !init?.method) return { status: 200, body: { messages: messageList } };
    if (url.includes("/edit")) return { status: 202, body: { runId: "r-edit" } };
    return { status: 404 };
  });
  render(<ChatMessageList sessionId="s1" />);
  return { fetchMock };
}

describe("用户消息编辑重发", () => {
  it("编辑按钮就地展开 textarea，保存并发送走 edit 路由", async () => {
    const { fetchMock } = setup();
    const editButton = await screen.findByRole("button", { name: "编辑重发" });
    fireEvent.click(editButton);
    const textarea = screen.getByRole("textbox", { name: "编辑消息" });
    expect((textarea as HTMLTextAreaElement).value).toBe("原始问题");
    fireEvent.change(textarea, { target: { value: "编辑后的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并发送" }));
    await waitFor(() => {
      const editCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/messages/u1/edit"));
      expect(editCall).toBeTruthy();
      expect(JSON.parse(String(editCall![1]!.body))).toEqual({ text: "编辑后的问题" });
    });
    // 编辑态关闭
    expect(screen.queryByRole("textbox", { name: "编辑消息" })).toBeNull();
  });

  it("Esc 取消不提交；带图片的用户消息不开放编辑", async () => {
    const { fetchMock } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "编辑重发" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "编辑消息" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "编辑消息" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/edit"))).toBe(false);
  });

  it("带图片的用户消息不显示编辑按钮", async () => {
    setup([
      makeMessage({ id: "u1", role: "user", content: [{ type: "text", text: "看图" }, { type: "image", ref: "uploads/x.png" } as ChatMessage["content"][number]] }),
    ]);
    await screen.findByText("看图");
    expect(screen.queryByRole("button", { name: "编辑重发" })).toBeNull();
  });
});

describe("回到底部浮钮", () => {
  it("贴底时不渲染；向上滚动出现后点击回底消失", async () => {
    setup();
    await screen.findByText("原始问题");
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
    const track = document.querySelector(".chat-messages")!;
    fireEvent.wheel(track, { deltaY: -100 });
    const jump = await screen.findByRole("button", { name: "回到底部" });
    fireEvent.click(jump);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });
});
