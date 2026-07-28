import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { EmptyState } from "../components/EmptyState";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  messages: [],
};

interface RecordedCall { url: string; method: string }

const calls: RecordedCall[] = [];

function installFetchMock(): void {
  calls.length = 0;
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions") && method === "GET") return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.includes("/api/sessions/s1/steering")) return json([]);
    if (url.includes("/api/sessions/s1/permissions")) return json([]);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/) && method === "DELETE") return json({}, 200);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(session);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", handler);
}

describe("App 会话操作与 /help", () => {
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
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    // jsdom 无布局：Composer 弹层/轨道的滚动定位打桩
    Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op */ };
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

  it("/help：打开快捷键速查、清空草稿、不发送消息", async () => {
    installFetchMock();
    renderApp();
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    fireEvent.change(textarea, { target: { value: "/help" } });
    // 第一次 Enter 采纳补全建议（写入 "/help "），第二次才真正发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    // 懒加载的 ShortcutsDialog 出现
    expect(await screen.findByText("键盘快捷方式")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(calls.some((call) => call.url.includes("/api/sessions/s1/messages") && call.method === "POST")).toBe(false);
  });

  it("删除会话走样式化确认框：取消不发 DELETE，确认才发", async () => {
    installFetchMock();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "删除会话 测试作业" }));
    // 确认框出现；原生 confirm 未触达
    expect(await screen.findByText(/删除会话「测试作业」？/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    // 再次打开并确认
    fireEvent.click(await screen.findByRole("button", { name: "删除会话 测试作业" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/api/sessions/s1"))).toBe(true));
    confirmSpy.mockRestore();
  });
});

describe("EmptyState 示例任务 chips", () => {
  it("点击 chip 把任务文案交给 onExample", () => {
    const onExample = vi.fn();
    render(
      <EmptyState
        sessions={[]}
        providers={["anthropic"]}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onExample={onExample}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "解释这个仓库的结构" }));
    expect(onExample).toHaveBeenCalledWith("解释这个仓库的结构");
    fireEvent.click(screen.getByRole("button", { name: "修一个 failing test 并给出原因" }));
    expect(onExample).toHaveBeenCalledWith("修一个 failing test 并给出原因");
  });

  it("未提供 onExample 时不渲染 chips", () => {
    render(<EmptyState sessions={[]} providers={["anthropic"]} onSelect={() => undefined} onCreate={() => undefined} />);
    expect(screen.queryByText("试试这些任务")).toBeNull();
  });
});
