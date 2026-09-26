// ChatComposer 图片附件：≤2MB 内嵌 base64 / >2MB 先 POST uploads 再发 ref / >10MB 拒绝 / 单消息 ≤3 张。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../ChatComposer";
import { ui } from "../../app/ui-store";
const INLINE_MAX = 2 * 1024 * 1024; const UPLOAD_MAX = 10 * 1024 * 1024;
const makeImage = (size: number): File => new File([new Uint8Array(size)], "pic.png", { type: "image/png" });
function mockFetch(handler: (url: string) => { status: number; body?: unknown }) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const reply = handler(String(input));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const defaultHandler = (url: string) => (url.includes("/uploads") ? { status: 201, body: { ref: "uploads/abc.png" } } : { status: 202, body: { runId: "r1" } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
/** 经文件选择加入图片并等待预览出现。 */
async function attach(view: ReturnType<typeof render>, files: File[]): Promise<void> {
  fireEvent.change(view.getByLabelText("选择图片文件"), { target: { files } });
  if (files.length <= 3) await waitFor(() => expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(files.length));
}
/** 取 POST /messages 的 JSON body。 */
function messagesBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input).includes("/messages") && (init as RequestInit | undefined)?.method === "POST");
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}
function send(view: ReturnType<typeof render>, text = "看图"): void {
  fireEvent.change(view.getByPlaceholderText("有问题，随便问"), { target: { value: text } });
  fireEvent.click(view.getByRole("button", { name: "发送" }));
}
describe("ChatComposer 图片附件", () => {
  it("≤2MB 图片直接 base64 内嵌进 content，不走 uploads；附件可移除", async () => {
    const fetchMock = mockFetch(defaultHandler); const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(100)]);
    fireEvent.click(view.getByRole("button", { name: "移除图片" })); expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(0);
    await attach(view, [makeImage(100)]);
    send(view);
    await waitFor(() => {
      const content = messagesBody(fetchMock).content as Array<Record<string, unknown>>;
      expect(content[0]).toEqual({ type: "text", text: "看图" }); expect(content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
      expect(typeof content[1]?.data).toBe("string"); expect(content[1]?.ref).toBeUndefined();
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/uploads"))).toBe(false);
  });
  it(">2MB 且 ≤10MB 图片先 POST uploads 再以 ref 引用块发送（uploads 先于 messages）", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(INLINE_MAX + 1)]);
    send(view);
    await waitFor(() => expect((messagesBody(fetchMock).content as Array<Record<string, unknown>>)[1]).toEqual({ type: "image", mediaType: "image/png", ref: "uploads/abc.png" }));
    const order = fetchMock.mock.calls.map(([input]) => String(input));
    expect(order.findIndex((url) => url.includes("/uploads"))).toBeLessThan(order.findIndex((url) => url.includes("/messages")));
  });
  it(">10MB 图片拒绝并 notify、不发任何请求；单消息最多 3 张，第 4 张拒绝", async () => {
    const fetchMock = mockFetch(defaultHandler); const notify = vi.spyOn(ui, "notify");
    const view = render(<ChatComposer sessionId="s1" />);
    fireEvent.change(view.getByLabelText("选择图片文件"), { target: { files: [makeImage(UPLOAD_MAX + 1)] } });
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("10MB"), "error"));
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(0); expect(fetchMock).not.toHaveBeenCalled();
    await attach(view, [makeImage(10), makeImage(10), makeImage(10), makeImage(10)]);
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("3"), "error"));
  });
  it("uploads 失败时保留草稿与附件，不发 messages", async () => {
    const fetchMock = mockFetch((url) => (url.includes("/uploads") ? { status: 413, body: { error: "image exceeds 10MB" } } : { status: 404 }));
    const notify = vi.spyOn(ui, "notify");
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(INLINE_MAX + 1)]);
    send(view);
    await waitFor(() => expect(notify).toHaveBeenCalledWith("图片上传失败", "error"));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/messages"))).toBe(false);
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(1);
  });
  it("纯图片消息（无文字）可发送：body 只有 image 块；无文字无图片时禁用", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    expect((view.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    await attach(view, [makeImage(100)]);
    expect((view.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const body = messagesBody(fetchMock);
      expect(body).not.toHaveProperty("text"); expect(body.content).toEqual([{ type: "image", mediaType: "image/png", data: expect.any(String) }]);
    });
  });
});
