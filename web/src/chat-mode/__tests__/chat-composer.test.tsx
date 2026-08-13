// ChatComposer 图片附件：≤2MB 内嵌 base64 / >2MB 先 POST uploads 再发 ref / >10MB 拒绝 / 单消息 ≤3 张。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../ChatComposer";
import { ui } from "../../app/ui-store";

const INLINE_MAX = 2 * 1024 * 1024;
const UPLOAD_MAX = 10 * 1024 * 1024;

function makeImage(size: number, name = "pic.png", type = "image/png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

interface MockReply {
  status: number;
  body?: unknown;
}

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

function defaultHandler(url: string): MockReply {
  if (url.includes("/uploads")) return { status: 201, body: { ref: "uploads/abc.png" } };
  if (url.includes("/messages")) return { status: 202, body: { runId: "r1" } };
  return { status: 404 };
}

beforeEach(() => {
  // jsdom 未实现 objectURL
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 经文件选择加入图片并等待预览出现。 */
async function attach(view: ReturnType<typeof render>, files: File[], expectedCount: number): Promise<void> {
  fireEvent.change(view.getByLabelText("选择图片文件"), { target: { files } });
  await waitFor(() => {
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(expectedCount);
  });
}

async function send(view: ReturnType<typeof render>, text = "看图"): Promise<void> {
  fireEvent.change(view.getByPlaceholderText("有问题，随便问"), { target: { value: text } });
  fireEvent.click(view.getByRole("button", { name: "发送" }));
}

function messagesBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input, init]) =>
    String(input).includes("/messages") && (init as RequestInit | undefined)?.method === "POST");
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

describe("ChatComposer 图片附件", () => {
  it("≤2MB 图片直接 base64 内嵌进 content，不走 uploads", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(100)], 1);
    await send(view);

    await waitFor(() => {
      const body = messagesBody(fetchMock);
      const content = body.content as Array<Record<string, unknown>>;
      expect(content[0]).toEqual({ type: "text", text: "看图" });
      expect(content[1]?.type).toBe("image");
      expect(content[1]?.mediaType).toBe("image/png");
      expect(typeof content[1]?.data).toBe("string");
      expect(content[1]?.ref).toBeUndefined();
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/uploads"))).toBe(false);
  });

  it(">2MB 且 ≤10MB 图片先 POST uploads 再以 ref 引用块发送", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(INLINE_MAX + 1)], 1);
    await send(view);

    await waitFor(() => {
      const body = messagesBody(fetchMock);
      const content = body.content as Array<Record<string, unknown>>;
      expect(content[1]).toEqual({ type: "image", mediaType: "image/png", ref: "uploads/abc.png" });
    });
    const uploadsCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/uploads"));
    expect(uploadsCall).toBeDefined();
    const uploadsBody = JSON.parse(String((uploadsCall![1] as RequestInit).body)) as Record<string, unknown>;
    expect(uploadsBody.mediaType).toBe("image/png");
    expect(typeof uploadsBody.data).toBe("string");
    // uploads 必须先于 messages
    const order = fetchMock.mock.calls.map(([input]) => String(input));
    expect(order.findIndex((url) => url.includes("/uploads"))).toBeLessThan(order.findIndex((url) => url.includes("/messages")));
  });

  it(">10MB 图片拒绝并 notify，不发任何请求", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const notifySpy = vi.spyOn(ui, "notify");
    const view = render(<ChatComposer sessionId="s1" />);
    fireEvent.change(view.getByLabelText("选择图片文件"), { target: { files: [makeImage(UPLOAD_MAX + 1)] } });

    await waitFor(() => {
      expect(notifySpy).toHaveBeenCalledWith(expect.stringContaining("10MB"), "error");
    });
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("单消息最多 3 张，第 4 张 notify 拒绝", async () => {
    mockFetch(defaultHandler);
    const notifySpy = vi.spyOn(ui, "notify");
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(10), makeImage(10), makeImage(10), makeImage(10)], 3);

    await waitFor(() => {
      expect(notifySpy).toHaveBeenCalledWith(expect.stringContaining("3"), "error");
    });
  });

  it("uploads 失败时保留草稿与附件，不发 messages", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/uploads")) return { status: 413, body: { error: "image exceeds 10MB" } };
      return { status: 404 };
    });
    const notifySpy = vi.spyOn(ui, "notify");
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(INLINE_MAX + 1)], 1);
    await send(view);

    await waitFor(() => {
      expect(notifySpy).toHaveBeenCalledWith("图片上传失败", "error");
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/messages"))).toBe(false);
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(1);
  });

  it("附件可移除", async () => {
    mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(100)], 1);
    fireEvent.click(view.getByRole("button", { name: "移除图片" }));
    expect(view.container.querySelectorAll(".chat-attachment")).toHaveLength(0);
  });

  it("纯图片消息（无文字）可发送：body 只含 image 块，不发 text 字段", async () => {
    const fetchMock = mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    await attach(view, [makeImage(100)], 1);
    // 无文字时发送按钮可用（vision「贴图即问」场景）
    expect((view.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      const body = messagesBody(fetchMock);
      expect(body).not.toHaveProperty("text");
      expect(body.content).toEqual([
        { type: "image", mediaType: "image/png", data: expect.any(String) },
      ]);
    });
  });

  it("无文字且无图片时发送按钮禁用", () => {
    mockFetch(defaultHandler);
    const view = render(<ChatComposer sessionId="s1" />);
    expect((view.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
