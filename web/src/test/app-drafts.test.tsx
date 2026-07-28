import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "草稿测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  messages: [],
};

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.includes("/api/sessions/s1/steering")) return json([]);
    if (url.includes("/api/sessions/s1/permissions")) return json([]);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(session);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", handler);
}

describe("App 草稿持久化（localStorage owc-draft-<id>）", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    window.localStorage.clear();
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as unknown as typeof window.matchMedia;
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  function renderApp(): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  }

  it("选中会话时从 localStorage 恢复草稿，并修剪已删除会话的草稿键", async () => {
    window.localStorage.setItem("owc-draft-s1", JSON.stringify("刷新前未发送"));
    window.localStorage.setItem("owc-draft-gone", JSON.stringify("已删会话残留"));
    installFetchMock();
    renderApp();

    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(textarea).toHaveValue("刷新前未发送");
    // 会话列表已加载：s1 存在保留，gone 不在列表被修剪
    expect(window.localStorage.getItem("owc-draft-gone")).toBeNull();
    expect(window.localStorage.getItem("owc-draft-s1")).not.toBeNull();
  });

  it("输入实时镜像到 localStorage，清空时删除条目", async () => {
    installFetchMock();
    renderApp();

    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(textarea).toHaveValue("");
    fireEvent.change(textarea, { target: { value: "正在输入" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("正在输入"));
    fireEvent.change(textarea, { target: { value: "" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBeNull();
  });
});
