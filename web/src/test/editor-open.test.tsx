/**
 * 编辑器入口与布局回归（0.5.0 Phase 1a 验收，App 级）：
 * - 新会话默认纯对话（无编辑器分栏）；切换会话关闭已打开的编辑器。
 * - 移动端不提供编辑器：入口降级为只读代码视图浮层，Monaco chunk 不加载。
 * Monaco 本体用 fake；isMobile 经 use-media-query mock 控制。
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { createFakeMonaco } from "./helpers/fake-monaco";
import type { MonacoApi } from "../components/editor/monaco-loader";

let mobileMatches = false;
vi.mock("../hooks/use-media-query", () => ({
  MOBILE_BREAKPOINT: "(max-width: 1024px)",
  useMediaQuery: () => mobileMatches,
}));

const fake = createFakeMonaco();
const loadMonacoMock = vi.fn<() => Promise<MonacoApi>>(() => Promise.resolve(fake.monaco));
vi.mock("../components/editor/monaco-loader", () => ({
  loadMonaco: () => loadMonacoMock(),
}));

const S1 = {
  id: "s1", cwd: "/workspace/project", provider: "anthropic", model: "claude-opus-4-8",
  thinking: "adaptive", effort: "high", permissionMode: "ask", title: "会话一",
  createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
  sandbox: { enabled: false, readRoots: [], writeRoots: [], denyPaths: [], network: "deny" },
  messages: [],
};
const S2 = { ...S1, id: "s2", title: "会话二" };

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([S1, S2].map(({ messages: _m, sandbox: _s, ...meta }) => meta));
    if (url.includes("/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.includes("/api/workspaces/")) return json({ error: "Symbol index is not enabled" }, 501);
    if (url.includes("/complete-path")) return json({ matches: [{ path: "src/a.ts" }] });
    if (url.includes("/files/content")) {
      if (init?.method === "PUT") return json({ ok: true, revision: "b".repeat(64) });
      return json({ content: "export const a = 1;\n", encoding: "utf-8", truncated: false, revision: "a".repeat(64) });
    }
    if (url.match(/\/api\/sessions\/(s1|s2)\//)) return json([]);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(S1);
    if (url.match(/\/api\/sessions\/s2(\?.*)?$/)) return json(S2);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

function renderApp(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

/** Ctrl+P 打开 Quick Open，输入触发查询，等待文件条目出现 */
async function openQuickOpen(view: ReturnType<typeof render>): Promise<HTMLElement> {
  fireEvent.keyDown(window, { key: "p", ctrlKey: true });
  const input = await view.findByRole("combobox", { name: "文件搜索" });
  fireEvent.change(input, { target: { value: "a.ts" } });
  await view.findByRole("option", { name: /a\.ts/ });
  return input;
}

describe("编辑器分栏：布局回归", () => {
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    mobileMatches = false;
    window.localStorage.clear();
    loadMonacoMock.mockClear();
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket {
      readyState = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      close(): void { this.readyState = 3; }
      send(): void { /* no-op */ }
      addEventListener(): void { /* no-op */ }
      removeEventListener(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    installFetchMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it("默认纯对话（无编辑器分栏）；Quick Open Ctrl+Enter 打开编辑器；切换会话后回到纯对话", async () => {
    const view = renderApp();
    // 新会话默认无编辑器
    await view.findByRole("heading", { name: "会话一" });
    expect(view.container.querySelector(".editor-pane")).toBeNull();

    const input = await openQuickOpen(view);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    // 编辑器分栏打开，Monaco 懒加载被触发
    await waitFor(() => expect(view.container.querySelector(".editor-pane")).not.toBeNull());
    expect(loadMonacoMock).toHaveBeenCalledTimes(1);

    // 切换会话 → 编辑器关闭，回到纯对话
    fireEvent.click((await view.findAllByText("会话二"))[0]);
    await waitFor(() => expect(view.container.querySelector(".editor-pane")).toBeNull());
  });

  it("移动端：Ctrl+Enter 也降级为只读浮层，不加载 Monaco chunk", async () => {
    mobileMatches = true;
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    const input = await openQuickOpen(view);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    // 降级为只读代码视图浮层
    await view.findByRole("dialog", { name: "src/a.ts" });
    expect(view.container.querySelector(".editor-pane")).toBeNull();
    expect(loadMonacoMock).not.toHaveBeenCalled();
  });

  it("窄窗口侧栏使用临时抽屉，不继承或改写桌面展开状态", async () => {
    window.localStorage.setItem("owc-rail-collapsed", "1");
    mobileMatches = true;
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });

    expect(view.container.querySelector(".wb-sidebar")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "会话" }));
    expect(view.container.querySelector(".wb-sidebar")).not.toBeNull();
    expect(view.getByRole("textbox", { name: "搜索会话" })).toBeInTheDocument();
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");

    fireEvent.click((await view.findAllByText("会话二"))[0]);
    await waitFor(() => expect(view.container.querySelector(".wb-sidebar")).toBeNull());
    expect(window.localStorage.getItem("owc-rail-collapsed")).toBe("1");
  });
});
