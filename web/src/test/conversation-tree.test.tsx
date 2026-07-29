import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { Composer } from "../components/Composer";
import { MessageCard } from "../components/MessageCard";
import { TimelinePanel } from "../components/panels/TimelinePanel";
import { api } from "../lib/api";
import type { ChatMessage, SessionDetail, SessionTimeline } from "../lib/contracts";

function textMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text }] };
}

describe("MessageCard 会话树操作按钮", () => {
  it("user 消息渲染编辑重发/重新生成/分叉三个按钮，点击回调携带消息", () => {
    const message = textMessage("m-u1", "user", "原始问题");
    const onEditMessage = vi.fn();
    const onRegenerate = vi.fn();
    const onFork = vi.fn();
    render(
      <MessageCard message={message} sessionId="s1" onEditMessage={onEditMessage} onRegenerate={onRegenerate} onFork={onFork} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /编辑重发/ }));
    expect(onEditMessage).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
    expect(onRegenerate).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole("button", { name: /分叉/ }));
    expect(onFork).toHaveBeenCalledWith(message);
  });

  it("运行中禁用编辑重发/重新生成（分叉仍可用）", () => {
    const message = textMessage("m-u2", "user", "问题");
    render(
      <MessageCard message={message} sessionId="s1" running onEditMessage={() => {}} onRegenerate={() => {}} onFork={() => {}} />,
    );

    expect(screen.getByRole("button", { name: /编辑重发/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /重新生成/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /分叉/ })).toBeEnabled();
  });

  it("assistant 消息不渲染会话树操作按钮", () => {
    render(
      <MessageCard message={textMessage("m-a1", "assistant", "回答")} sessionId="s1" onEditMessage={() => {}} onRegenerate={() => {}} onFork={() => {}} />,
    );

    expect(screen.queryByRole("button", { name: /编辑重发/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重新生成/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /分叉/ })).toBeNull();
  });
});

const composerSession: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "编辑测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  messages: [],
};

function EditComposerHarness({ editing, onCancelEdit }: {
  editing: { messageId: string; hadAttachments: boolean };
  onCancelEdit(): void;
}): ReturnType<typeof Composer> {
  const [draft, setDraft] = useState("编辑中的文本");
  return (
    <Composer
      current={composerSession}
      models={[]}
      draft={draft}
      setDraft={setDraft}
      onSend={() => {}}
      onConfig={() => {}}
      running={false}
      sendKey="enter"
      skills={[]}
      attachments={[]}
      setAttachments={() => {}}
      supportsImages={false}
      onNotice={() => {}}
      editingMessage={editing}
      onCancelEdit={onCancelEdit}
    />
  );
}

describe("Composer 编辑重发状态", () => {
  it("展示编辑横幅，取消按钮与 Esc 都触发 onCancelEdit", () => {
    const onCancelEdit = vi.fn();
    render(<EditComposerHarness editing={{ messageId: "m-u1", hadAttachments: false }} onCancelEdit={onCancelEdit} />);

    expect(screen.getByText("正在编辑早前消息")).toBeInTheDocument();
    expect(screen.queryByText(/附件不会重发/)).toBeNull();
    // 发送按钮文案变为「重发」
    expect(screen.getByRole("button", { name: /重发/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancelEdit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("combobox", { name: /消息输入框/ }), { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalledTimes(2);
  });

  it("原消息含附件时横幅提示仅发送文本", () => {
    render(<EditComposerHarness editing={{ messageId: "m-u2", hadAttachments: true }} onCancelEdit={() => {}} />);

    expect(screen.getByText(/附件不会重发，仅发送文本/)).toBeInTheDocument();
  });
});

const appSession: SessionDetail = {
  ...composerSession,
  title: "会话树作业",
  messages: [
    textMessage("msg-u1", "user", "原始问题"),
    textMessage("msg-a1", "assistant", "原始回答"),
  ],
};

const forkedSession: SessionDetail = { ...appSession, id: "s2", title: "会话树作业 (fork)" };

interface RecordedCall { url: string; method: string; body?: string }

function installFetchMock(calls: RecordedCall[]): void {
  calls.length = 0;
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions") && method === "GET") return json([{ id: appSession.id, cwd: appSession.cwd, provider: appSession.provider, model: appSession.model, title: appSession.title, createdAt: appSession.createdAt, updatedAt: appSession.updatedAt }]);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.includes("/steering")) return json([]);
    if (url.includes("/permissions")) return json([]);
    if (url.includes("/messages/msg-u1/retry") && method === "POST") return json({ ok: true }, 202);
    if (url.endsWith("/api/sessions/s1/fork") && method === "POST") return json({ sessionId: "s2" }, 201);
    if (url.match(/\/api\/sessions\/s2(\?.*)?$/)) return json(forkedSession);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(appSession);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", handler);
}

describe("App 编辑重发 / 重新生成 / 分叉", () => {
  const calls: RecordedCall[] = [];
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
    Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op */ };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  function renderApp(): void {
    installFetchMock(calls);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  }

  it("编辑重发：进入编辑态灌入原文，发送走 retry 接口并携带 editedContent", async () => {
    renderApp();
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    // 先留一个草稿，验证编辑期间不被混淆、取消后可恢复
    fireEvent.change(textarea, { target: { value: "未发送的草稿" } });

    fireEvent.click(await screen.findByRole("button", { name: /编辑重发/ }));
    expect(await screen.findByText("正在编辑早前消息")).toBeInTheDocument();
    expect(textarea).toHaveValue("原始问题");

    // 取消恢复之前的草稿
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(textarea).toHaveValue("未发送的草稿");
    expect(screen.queryByText("正在编辑早前消息")).toBeNull();

    // 再次进入并发送：走 retry 而非普通消息 POST，发送后退出编辑态并清空草稿
    fireEvent.click(screen.getByRole("button", { name: /编辑重发/ }));
    fireEvent.change(textarea, { target: { value: "改写过的问题" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      const retry = calls.find((call) => call.url.includes("/api/sessions/s1/messages/msg-u1/retry") && call.method === "POST");
      expect(retry).toBeDefined();
      expect(JSON.parse(retry!.body ?? "{}")).toEqual({ editedContent: "改写过的问题" });
    });
    expect(calls.some((call) => call.url.match(/\/api\/sessions\/s1\/messages$/) && call.method === "POST")).toBe(false);
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.queryByText("正在编辑早前消息")).toBeNull();
  });

  it("编辑重发中 Esc 取消并恢复草稿", async () => {
    renderApp();
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    fireEvent.change(textarea, { target: { value: "Esc 前的草稿" } });

    fireEvent.click(await screen.findByRole("button", { name: /编辑重发/ }));
    expect(textarea).toHaveValue("原始问题");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(textarea).toHaveValue("Esc 前的草稿");
    expect(screen.queryByText("正在编辑早前消息")).toBeNull();
    expect(calls.some((call) => call.url.includes("/retry"))).toBe(false);
  });

  it("重新生成：直接调 retry 接口且不附带 editedContent", async () => {
    renderApp();
    await screen.findByRole("combobox", { name: /消息输入框/ });

    fireEvent.click(await screen.findByRole("button", { name: /重新生成/ }));
    await waitFor(() => {
      const retry = calls.find((call) => call.url.includes("/api/sessions/s1/messages/msg-u1/retry") && call.method === "POST");
      expect(retry).toBeDefined();
      expect(JSON.parse(retry!.body ?? "{}")).toEqual({});
    });
  });

  it("分叉：调 fork 接口并切换到新会话", async () => {
    renderApp();
    await screen.findByRole("combobox", { name: /消息输入框/ });

    fireEvent.click(await screen.findByRole("button", { name: /分叉/ }));
    await waitFor(() => {
      const fork = calls.find((call) => call.url.endsWith("/api/sessions/s1/fork") && call.method === "POST");
      expect(fork).toBeDefined();
      expect(JSON.parse(fork!.body ?? "{}")).toEqual({ messageId: "msg-u1" });
    });
    // 切换到新会话：发起 s2 的详情查询
    await waitFor(() => expect(calls.some((call) => call.url.match(/\/api\/sessions\/s2\?/) && call.method === "GET")).toBe(true));
  });
});

const timelineData: SessionTimeline = {
  activeLeafId: "n3",
  entries: [
    { id: "n1", role: "user", createdAt: "2026-07-20T00:00:00.000Z", onActivePath: true },
    { id: "n2", role: "assistant", createdAt: "2026-07-20T00:00:01.000Z", runId: "run-1", turnId: "turn-1", onActivePath: true },
    { id: "n3", role: "user", createdAt: "2026-07-20T00:00:02.000Z", onActivePath: true },
    { id: "n4", role: "user", createdAt: "2026-07-20T00:00:03.000Z", onActivePath: false },
  ],
};

describe("TimelinePanel 会话树", () => {
  afterEach(() => vi.restoreAllMocks());

  function renderPanel(running = false, onForkSession?: (id: string) => void): { container: HTMLElement } {
    vi.spyOn(api, "timeline").mockResolvedValue(timelineData);
    vi.spyOn(api, "checkpoints").mockResolvedValue([]);
    vi.spyOn(api, "snapshotCapability").mockResolvedValue({ backend: "git-shadow", costHint: "instant", requiresAdmin: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <TimelinePanel sessionId="s1" running={running} onNotice={() => {}} {...(onForkSession ? { onForkSession } : {})} />
      </QueryClientProvider>,
    );
    return { container };
  }

  it("渲染全部树节点，非活动路径节点降透明度，当前叶节点保留「当前」标记", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll(".timeline-node")).toHaveLength(4));

    const rows = [...container.querySelectorAll<HTMLElement>(".timeline-node")];
    expect(rows[3]!.classList.contains("off-path")).toBe(true);
    expect(rows[0]!.classList.contains("off-path")).toBe(false);
    expect(within(rows[2]!).getByText("当前")).toBeInTheDocument();
    // 当前叶节点的「继续」禁用，其余可用
    expect(within(rows[2]!).getByRole("button", { name: "继续" })).toBeDisabled();
    expect(within(rows[0]!).getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("「继续」检出到对应节点，「分叉」从对应节点分叉并回调切换", async () => {
    const checkoutSpy = vi.spyOn(api, "checkoutSession").mockResolvedValue({ ok: true, activeLeafId: "n1" });
    const forkSpy = vi.spyOn(api, "forkSession").mockResolvedValue({ sessionId: "s-fork" });
    const onForkSession = vi.fn();
    const { container } = renderPanel(false, onForkSession);
    await waitFor(() => expect(container.querySelectorAll(".timeline-node")).toHaveLength(4));
    const rows = [...container.querySelectorAll<HTMLElement>(".timeline-node")];

    fireEvent.click(within(rows[0]!).getByRole("button", { name: "继续" }));
    await waitFor(() => expect(checkoutSpy).toHaveBeenCalledWith("s1", "n1"));

    fireEvent.click(within(rows[3]!).getByRole("button", { name: "分叉" }));
    await waitFor(() => expect(forkSpy).toHaveBeenCalledWith("s1", { messageId: "n4" }));
    await waitFor(() => expect(onForkSession).toHaveBeenCalledWith("s-fork"));
  });

  it("运行中禁用全部「继续」（分叉仍可用）", async () => {
    const { container } = renderPanel(true);
    await waitFor(() => expect(container.querySelectorAll(".timeline-node")).toHaveLength(4));
    const rows = [...container.querySelectorAll<HTMLElement>(".timeline-node")];

    for (const row of rows) {
      expect(within(row).getByRole("button", { name: "继续" })).toBeDisabled();
      expect(within(row).getByRole("button", { name: "分叉" })).toBeEnabled();
    }
  });
});
