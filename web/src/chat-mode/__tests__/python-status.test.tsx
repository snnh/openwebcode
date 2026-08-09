// python_status SSE 事件 → chatModeStore → PythonStatusBadge 渲染（preparing/ready/error 三态）。
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList } from "../ChatMessageList";
import { PythonStatusBadge } from "../PythonStatusBadge";
import { chatMode } from "../../app/chat-mode-store";

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
  messages: [],
};

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => DETAIL,
  }) as Response));
  chatMode.setPythonStatus("s1", "idle");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("python_status 事件链路", () => {
  it("SSE python_status 写入 store，Badge 按状态渲染", async () => {
    const view = render(
      <>
        <ChatMessageList sessionId="s1" />
        <PythonStatusBadge sessionId="s1" />
      </>,
    );
    // 初始未初始化
    expect(await view.findByText("未初始化")).toHaveClass("pill");

    const es = MockEventSource.instances[0]!;
    act(() => es.emit({ type: "python_status", runId: "r1", status: "preparing" }));
    expect(view.getByText("启动中")).toHaveClass("pill", "amber");

    act(() => es.emit({ type: "python_status", runId: "r1", status: "ready" }));
    expect(view.getByText("就绪")).toHaveClass("pill", "ok");

    act(() => es.emit({ type: "python_status", runId: "r1", status: "error", detail: "boom" }));
    expect(view.getByText("失败")).toHaveClass("pill", "danger");
  });
});
