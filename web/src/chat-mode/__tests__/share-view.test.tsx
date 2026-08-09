// ShareView 密码门：错误密码提示、429 锁定提示、验证成功后渲染消息（token 透传到 messages 请求）。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareView } from "../ShareView";

interface MockReply {
  status: number;
  body?: unknown;
}

function mockFetch(handler: (url: string, init?: RequestInit) => MockReply) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const reply = handler(url, init);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ShareView 密码门", () => {
  it("错误密码展示提示", async () => {
    mockFetch((url) => {
      if (url.includes("/verify")) return { status: 401, body: { error: "Invalid password" } };
      return { status: 404 };
    });
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    const input = await view.findByLabelText("输入密码");
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(view.getByRole("button", { name: "验证" }));
    expect(await view.findByRole("alert")).toHaveTextContent("密码错误");
  });

  it("429 锁定展示剩余秒数", async () => {
    mockFetch((url) => {
      if (url.includes("/verify")) return { status: 429, body: { error: "Too many attempts, try again in 42s" } };
      return { status: 404 };
    });
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    const alert = await view.findByRole("alert");
    expect(alert).toHaveTextContent("42");
  });

  it("验证成功渲染消息且 token 透传到 messages 请求", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/verify")) return { status: 200, body: { verified: true, shareId: "abcdef12", slug: "chat", token: "tok123" } };
      if (url.includes("/messages")) {
        return {
          status: 200,
          body: {
            title: "被分享的对话",
            messages: [
              { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: "2026-01-01T00:00:00Z" },
              { id: "m2", role: "assistant", content: [{ type: "text", text: "你好，世界" }], createdAt: "2026-01-01T00:00:01Z" },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    expect(await view.findByText("被分享的对话")).toBeInTheDocument();
    expect(await view.findByText("你好，世界")).toBeInTheDocument();
    await waitFor(() => {
      const messagesCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/messages"));
      expect(messagesCall).toBeDefined();
      expect(String(messagesCall![0])).toContain("token=tok123");
    });
  });

  it("ref 形态 image 块经分享 images 路由构造 src（透传 token）", async () => {
    mockFetch((url) => {
      if (url.includes("/verify")) return { status: 200, body: { verified: true, token: "tok123" } };
      if (url.includes("/messages")) {
        return {
          status: 200,
          body: {
            title: "带图分享",
            messages: [
              {
                id: "m1",
                role: "assistant",
                content: [
                  { type: "text", text: "这是生成的图" },
                  { type: "image", mediaType: "image/png", ref: "uploads/pic.png" },
                ],
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        };
      }
      return { status: 404 };
    });
    const view = render(<ShareView shareId="abcdef12" slug="chat" />);
    await view.findByText("这是生成的图");
    const img = view.container.querySelector("img.chat-block-image");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("/api/share/abcdef12/images/uploads/pic.png?token=tok123");
  });
});
