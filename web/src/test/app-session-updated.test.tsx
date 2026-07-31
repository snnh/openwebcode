import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../lib/contracts";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const userText = "请处理这个任务";

const session = makeSession({
  title: "当前会话",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [
    { id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] },
    // 最近的「用户消息」是 `!` 前缀 shell 快捷消息：重试必须跳过它
    { id: "user-2", role: "user", createdAt: "2026-07-28T00:01:00.000Z", content: [{ type: "text", text: "!ls -la" }] },
  ],
});

const otherSession = { id: "s2", cwd: "/workspace/other", provider: "anthropic", model: "claude-opus-4-8", title: "另一个会话", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z" };

const settingsView: SettingsView = {
  groups: [{
    id: "updateCheck",
    label: "更新检查",
    fields: [
      { key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: true, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false },
    ],
  }],
};

const updateAvailable = {
  snapshot: { latestVersion: "9.9.9", isNewer: true, htmlUrl: "https://example.com/release", publishedAt: "2026-07-28T00:00:00.000Z", checkedAt: "2026-07-28T00:00:00.000Z" },
};

interface RecordedRequest { url: string; method: string; body?: unknown; }

const requests: RecordedRequest[] = [];
let sessionsGetCount = 0;
let detailGetCount = 0;
// holdSend=true 时 POST /messages 挂起，直到 releaseSend()（用于发送中禁用重试按钮的断言）
let heldSend: (() => void) | undefined;

function releaseSend(): void {
  heldSend?.();
  heldSend = undefined;
}

function installFetchMock(options: { holdSend?: boolean } = {}): void {
  installAppFetchMock({
    session,
    extra: (url, json) => {
      if (url.endsWith("/api/sessions")) {
        sessionsGetCount += 1;
        return json([
          { id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt },
          otherSession,
        ]);
      }
      if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) {
        detailGetCount += 1;
        return json(session);
      }
      if (url.endsWith("/api/extensions")) return json([]);
      if (url.endsWith("/api/settings")) return json(settingsView);
      if (url.endsWith("/api/update-check")) return json(updateAvailable);
      if (url.endsWith("/api/health")) return json({ status: "ok" });
      if (url.endsWith("/api/version")) return json({ server: "0.7.0", core: "0.7.0" });
      return undefined;
    },
  });
  // 包一层处理非 GET：记录请求体（重试断言）+ holdSend 挂起发送
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET") return inner(input, init);
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes(`/api/sessions/${session.id}/messages`)) {
      if (options.holdSend) return new Promise<Response>((resolve) => { heldSend = () => resolve(json({ accepted: true })); });
      return json({ accepted: true });
    }
    return json({ ok: true });
  });
}

setupStubWebSocket();

describe("App 会话事件与重试行为", () => {
  beforeEach(() => {
    // jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    Element.prototype.scrollTo = function scrollTo() { /* no-op */ } as typeof Element.prototype.scrollTo;
    requests.length = 0;
    sessionsGetCount = 0;
    detailGetCount = 0;
    heldSend = undefined;
  });
  afterEach(() => {
    releaseSend();
  });

  async function renderLoadedApp(): Promise<StubSocket> {
    renderApp();
    // 等会话详情加载完成（用户消息渲染进轨道），确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return lastSocket();
  }

  it("session.updated：非当前会话只刷新会话列表，当前会话同时刷新详情", async () => {
    installFetchMock();
    const socket = await renderLoadedApp();
    const sessionsBefore = sessionsGetCount;
    const detailBefore = detailGetCount;

    // 另一个客户端重命名了非当前会话：列表必须刷新（否则 rail 标题不更新），详情不刷
    act(() => {
      emitEvent(socket, "session.updated", { ...otherSession, title: "改名了" }, { sessionId: "s2" });
    });
    await waitFor(() => expect(sessionsGetCount).toBeGreaterThan(sessionsBefore));
    expect(detailGetCount).toBe(detailBefore);

    // 当前会话的 session.updated：详情也刷新
    act(() => {
      emitEvent(socket, "session.updated", { ...session, title: "当前改名" });
    });
    await waitFor(() => expect(detailGetCount).toBeGreaterThan(detailBefore));
  });

  it("重试跳过 `!` 前缀 shell 消息，重发最近一条真正的用户消息", async () => {
    installFetchMock();
    const socket = await renderLoadedApp();

    act(() => {
      emitEvent(socket, "agent.error", { message: "rate limited", kind: "rate_limit", retryable: true });
    });

    const retry = await screen.findByRole("button", { name: "重试" });
    expect(retry.getAttribute("title")).toContain("附件不随重试重发");
    fireEvent.click(retry);
    await waitFor(() => {
      const post = requests.find((request) => request.url.includes(`/api/sessions/${session.id}/messages`));
      expect(post?.method).toBe("POST");
      expect(post?.body).toMatchObject({ content: userText, behavior: "start" });
    });
  });

  it("发送进行中重试按钮禁用，防止双击重发", async () => {
    installFetchMock({ holdSend: true });
    const socket = await renderLoadedApp();

    act(() => {
      emitEvent(socket, "agent.error", { message: "rate limited", kind: "rate_limit", retryable: true });
    });

    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    releaseSend();
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("同一通知目标重复点击仍重新跳转设置页签", async () => {
    installFetchMock();
    await renderLoadedApp();

    const openNotifications = async (): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: /通知中心/ }));
      await screen.findByText(/发现新版本 v9\.9\.9/);
    };
    const clickUpdateNotification = (): void => {
      fireEvent.click(screen.getByRole("button", { name: /发现新版本 v9\.9\.9.*（点击跳转）/ }));
    };

    await openNotifications();
    clickUpdateNotification();
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });

    // 用户手动切到别的页签后再次点击同一通知：必须重新跳回服务信息页签
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="appearance"]')?.className).toContain("active");
    });
    await openNotifications();
    clickUpdateNotification();
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });
  });
});
