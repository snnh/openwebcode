// ChatMessageList：重新生成按钮（仅 assistant 消息、请求形状、409 提示运行中）。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList } from "../ChatMessageList";
import { ui } from "../../app/ui-store";

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const DETAIL = {
  id: "s1",
  title: "对话",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  provider: "anthropic",
  model: "claude",
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "问题" }], createdAt: "2026-01-01T00:00:00Z" },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }], createdAt: "2026-01-01T00:00:01Z" },
  ],
};

function stubFetch(reply: () => { status: number; body?: unknown }) {
  const mock = vi.fn(async () => {
    const { status, body } = reply();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatMessageList 重新生成", () => {
  it("仅 assistant 消息显示重新生成按钮，点击发送正确请求", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/retry")) {
        return { ok: true, status: 202, json: async () => ({ runId: "r1" }) } as Response;
      }
      return { ok: true, status: 200, json: async () => DETAIL } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ChatMessageList sessionId="s1" />);
    const button = await view.findByRole("button", { name: "重新生成" });
    // user 消息没有重新生成按钮（仅一个，属于 assistant）
    expect(view.getAllByRole("button", { name: "重新生成" })).toHaveLength(1);

    fireEvent.click(button);
    await waitFor(() => {
      const retryCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).includes("/api/chat/sessions/s1/messages/a1/retry") && (init as RequestInit | undefined)?.method === "POST");
      expect(retryCall).toBeDefined();
      expect((retryCall![1] as RequestInit).credentials).toBe("include");
    });
  });

  it("409 时 notify 提示运行中", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));
    const view = render(<ChatMessageList sessionId="s1" />);
    const button = await view.findByRole("button", { name: "重新生成" });

    vi.restoreAllMocks();
    stubFetch(() => ({ status: 409, body: { error: "Session is already running" } }));
    const notifySpy = vi.spyOn(ui, "notify");

    fireEvent.click(button);
    await waitFor(() => {
      expect(notifySpy).toHaveBeenCalledWith(expect.stringContaining("运行"), "error");
    });
  });

  it("ref 形态 image 块经会话 images 路由构造 src", async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        ...DETAIL,
        messages: [
          {
            id: "t1",
            role: "tool",
            content: [
              { type: "text", text: "已生成图片" },
              { type: "image", mediaType: "image/png", ref: "generated/xyz.png" },
            ],
            createdAt: "2026-01-01T00:00:02Z",
          },
        ],
      },
    }));
    const view = render(<ChatMessageList sessionId="s1" />);
    await view.findByText("已生成图片");
    const img = view.container.querySelector("img.chat-block-image");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/chat/sessions/s1/images/generated/xyz.png");
  });

  it("历史 assistant 消息含 thinking 块时渲染为「思考过程」折叠区", async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        ...DETAIL,
        messages: [
          {
            id: "a2",
            role: "assistant",
            content: [
              { type: "thinking", text: "先分析再回答", provider: "deepseek" },
              { type: "text", text: "结论" },
            ],
            createdAt: "2026-01-01T00:00:02Z",
          },
        ],
      },
    }));
    const view = render(<ChatMessageList sessionId="s1" />);
    await view.findByText("结论");
    const thinking = view.container.querySelector("details.thinking");
    expect(thinking).not.toBeNull();
    expect(thinking!.querySelector("summary")?.textContent).toContain("思考过程");
    // 默认折叠：无 open 属性，点击 summary 展开（原生 details 无论开闭正文都在 textContent
    // 中，折叠语义应断言 open 属性而非文本可见性）
    expect(thinking!.hasAttribute("open")).toBe(false);
    fireEvent.click(thinking!.querySelector("summary")!);
    expect(thinking!.hasAttribute("open")).toBe(true);
    expect(thinking!.textContent).toContain("先分析再回答");
  });

  it("thinking_delta SSE 增量进入流式「正在思考」区，done 后清空", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));
    const view = render(<ChatMessageList sessionId="s1" />);
    await view.findByText("回答");

    const es = MockEventSource.instances.find((instance) => instance.url.includes("/stream"))!;
    es.emit({ type: "connected", running: false });
    es.emit({ type: "thinking_delta", runId: "r1", text: "正在推" });
    es.emit({ type: "thinking_delta", runId: "r1", text: "理中" });

    // 流式思考区：live 折叠态（rAF 合批提交后出现）
    const live = await view.findByText("正在思考");
    const details = live.closest("details");
    expect(details?.className).toContain("live");

    // done 清空流式区，历史重拉
    es.emit({ type: "done", runId: "r1", stopReason: "end_turn" });
    await waitFor(() => {
      expect(view.container.querySelector("details.thinking.live")).toBeNull();
    });
  });
});
