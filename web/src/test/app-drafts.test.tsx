import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const sessionB: SessionDetail = {
  ...session,
  id: "s2",
  title: "另一个作业",
};

function installFetchMock(extraSessions: SessionDetail[] = []): void {
  const all = [session, ...extraSessions];
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json(all.map(({ id, cwd, provider, model, title, createdAt, updatedAt }) => ({ id, cwd, provider, model, title, createdAt, updatedAt })));
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.includes("/steering")) return json([]);
    if (url.includes("/permissions")) return json([]);
    const detail = all.find((entry) => url.match(new RegExp(`/api/sessions/${entry.id}(\\?.*)?$`)));
    if (detail) return json(detail);
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

  it("镜像只写变化的草稿键，不重写其他会话", async () => {
    installFetchMock([sessionB]);
    renderApp();

    // s1 输入草稿
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    fireEvent.change(textarea, { target: { value: "一" } });
    expect(window.localStorage.getItem("owc-draft-s1")).toBe(JSON.stringify("一"));

    // 切到 s2 输入草稿
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("另一个作业"))!);
    const textareaB = await screen.findByRole("combobox", { name: /消息输入框/ });
    await waitFor(() => expect(textareaB).toHaveValue(""));
    fireEvent.change(textareaB, { target: { value: "二" } });
    expect(window.localStorage.getItem("owc-draft-s2")).toBe(JSON.stringify("二"));

    // 切回 s1，再打一键：只重写 s1 的草稿键
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".session-link")].find((link) => link.textContent?.includes("草稿测试作业"))!);
    const textareaA = await screen.findByRole("combobox", { name: /消息输入框/ });
    await waitFor(() => expect(textareaA).toHaveValue("一"));
    const spy = vi.spyOn(Storage.prototype, "setItem");
    try {
      fireEvent.change(textareaA, { target: { value: "一改" } });
      const draftWrites = spy.mock.calls.filter(([key]) => String(key).startsWith("owc-draft-"));
      expect(draftWrites).toEqual([["owc-draft-s1", JSON.stringify("一改")]]);
    } finally {
      spy.mockRestore();
    }
    expect(window.localStorage.getItem("owc-draft-s2")).toBe(JSON.stringify("二"));
  });
});
