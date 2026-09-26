// ChatMessageList：重新生成（仅 assistant、请求形状、409 提示）、图片路由、思考块（历史折叠 / 流式 live）。
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageList } from "../ChatMessageList";
import { ui } from "../../app/ui-store";
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(public url: string) { MockEventSource.instances.push(this); }
  close(): void { /* no-op */ }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const DETAIL = { id: "s1", title: "对话", provider: "anthropic", model: "claude", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "问题" }], createdAt: "2026-01-01T00:00:00Z" },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "回答" }], createdAt: "2026-01-01T00:00:01Z" }] };
/** 路由式 fetch 桩。 */
function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => { status: number; body?: unknown }) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = handler(input, init);
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal("EventSource", MockEventSource); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("ChatMessageList", () => {
  it("仅 assistant 消息显示重新生成按钮；点击 POST retry（带凭据），409 时提示运行中", async () => {
    const fetchMock = stubFetch((input, init) => (init?.method === "POST" && String(input).includes("/retry") ? { status: 202, body: { runId: "r1" } } : { status: 200, body: DETAIL }));
    const view = render(<ChatMessageList sessionId="s1" />);
    const button = await view.findByRole("button", { name: "重新生成" });
    expect(view.getAllByRole("button", { name: "重新生成" })).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => {
      const retry = fetchMock.mock.calls.find(([input, init]) => String(input).includes("/api/chat/sessions/s1/messages/a1/retry") && (init as RequestInit | undefined)?.method === "POST");
      expect((retry![1] as RequestInit).credentials).toBe("include");
    });
    stubFetch(() => ({ status: 409, body: { error: "Session is already running" } }));
    const notify = vi.spyOn(ui, "notify");
    fireEvent.click(button);
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("运行"), "error"));
  });
  it("ref image 块经会话 images 路由构造 src；历史 thinking 渲染默认折叠的「思考过程」", async () => {
    stubFetch(() => ({ status: 200, body: { ...DETAIL, messages: [{ id: "t1", role: "tool", createdAt: "2026-01-01T00:00:02Z", content: [
      { type: "text", text: "已生成图片" }, { type: "image", mediaType: "image/png", ref: "generated/xyz.png" }] }] } }));
    const imageView = render(<ChatMessageList sessionId="s1" />);
    await imageView.findByText("已生成图片");
    expect(imageView.container.querySelector("img.chat-block-image")!.getAttribute("src")).toBe("/api/chat/sessions/s1/images/generated/xyz.png");
    cleanup();
    stubFetch(() => ({ status: 200, body: { ...DETAIL, messages: [{ id: "a2", role: "assistant", createdAt: "2026-01-01T00:00:02Z", content: [
      { type: "thinking", text: "先分析再回答", provider: "deepseek" }, { type: "text", text: "结论" }] }] } }));
    const view = render(<ChatMessageList sessionId="s1" />);
    await view.findByText("结论");
    const thinking = view.container.querySelector("details.thinking") as HTMLDetailsElement;
    expect(thinking.querySelector("summary")?.textContent).toContain("思考过程");
    expect(thinking.hasAttribute("open")).toBe(false);
    fireEvent.click(thinking.querySelector("summary")!);
    expect(thinking.hasAttribute("open")).toBe(true); expect(thinking.textContent).toContain("先分析再回答");
  });
  it("thinking_delta SSE 增量进入流式「正在思考」区，done 后清空", async () => {
    stubFetch(() => ({ status: 200, body: DETAIL }));
    const view = render(<ChatMessageList sessionId="s1" />);
    await view.findByText("回答");
    const es = MockEventSource.instances.find((instance) => instance.url.includes("/stream"))!;
    es.emit({ type: "connected", running: false });
    es.emit({ type: "thinking_delta", runId: "r1", text: "正在推" }); es.emit({ type: "thinking_delta", runId: "r1", text: "理中" });
    expect((await view.findByText("正在思考")).closest("details")?.className).toContain("live");
    es.emit({ type: "done", runId: "r1", stopReason: "end_turn" });
    await waitFor(() => expect(view.container.querySelector("details.thinking.live")).toBeNull());
  });
});
