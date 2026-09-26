// ShareView 密码门：错误密码/429 锁定提示、验证成功后渲染消息（token 透传到 messages/images 请求）。
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareView } from "../ShareView";
function mockFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const reply = handler(typeof input === "string" ? input : input.toString());
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const verifiedHandler = (body: Record<string, unknown>) => (url: string) =>
  (url.includes("/verify") ? { status: 200, body: { verified: true, token: "tok123" } } : url.includes("/messages") ? { status: 200, body } : { status: 404 });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("ShareView 密码门", () => {
  it("错误密码展示提示；429 锁定展示剩余秒数", async () => {
    mockFetch((url) => (url.includes("/verify") ? { status: 401, body: { error: "Invalid password" } } : { status: 404 }));
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    fireEvent.change(await view.findByLabelText("输入密码"), { target: { value: "wrong" } });
    fireEvent.click(view.getByRole("button", { name: "验证" }));
    expect(await view.findByRole("alert")).toHaveTextContent("密码错误");
    mockFetch((url) => (url.includes("/verify") ? { status: 429, body: { error: "Too many attempts, try again in 42s" } } : { status: 404 }));
    view.unmount();
    expect(await render(<ShareView shareId="abcdef12" slug="chat" />).findByRole("alert")).toHaveTextContent("42");
  });
  it("验证成功渲染标题与消息，token 透传到 messages 请求；ref image 块经分享 images 路由构造 src", async () => {
    const fetchMock = mockFetch(verifiedHandler({
      title: "被分享的对话",
      messages: [
        { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: "2026-01-01T00:00:00Z" },
        { id: "m2", role: "assistant", content: [{ type: "text", text: "你好，世界" }, { type: "image", mediaType: "image/png", ref: "uploads/pic.png" }], createdAt: "2026-01-01T00:00:01Z" },
      ],
    }));
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    expect(await view.findByText("被分享的对话")).toBeInTheDocument();
    expect(await view.findByText("你好，世界")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.includes("/messages"))).toContain("token=tok123");
    expect(view.container.querySelector("img.chat-block-image")!.getAttribute("src")).toBe("/api/share/abcdef12/images/uploads/pic.png?token=tok123");
  });
});
