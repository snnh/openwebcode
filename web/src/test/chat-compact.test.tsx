import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { setSendKey } from "../app/prefs-store";
import { ui } from "../app/ui-store";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

/**
 * /compact 发送链路：pending 期间防重复提交（压缩可能耗时，避免二次压缩/run 抢写账本）；
 * 无可压缩区段（compacted=false）时 toast 服务端返回的原因（changed 的提示由 WS 事件负责）。
 */

const session = makeSession({
  id: "s1",
  title: "压缩提示作业",
  messages: [
    { id: "m1", role: "user", createdAt: "2026-08-11T00:00:00.000Z", content: [{ type: "text", text: "你好" }] },
  ],
});

setupStubWebSocket();

beforeEach(() => {
  window.localStorage.clear();
  setSendKey("enter");
  // toast/通知中心在模块级 uiStore，用例间需清理避免串扰
  ui.setNotice(undefined);
  ui.clearNotifications();
});

describe("/compact 发送反馈", () => {
  it("pending 期间重复提交被忽略；compacted=false 时 toast 原因", async () => {
    installAppFetchMock({ session, models: [] });
    const inner = globalThis.fetch;
    let posts = 0;
    let release: (value: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/api/sessions/s1/messages")) {
        posts += 1;
        return gate;
      }
      return inner(input, init);
    });

    renderWithClient(<App />);
    const textarea = (await waitFor(() => {
      const element = document.getElementById("composer-input");
      expect(element).not.toBeNull();
      return element;
    })) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/compact" } });
    // 输入 "/" 前缀会打开命令补全弹层：第一次 Enter 选中补全项（填入 "/compact "），第二次才真正发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(posts).toBe(1));

    // 请求挂起期间再次 Enter：send.isPending 防重，不再发第二个 POST
    await act(async () => {});
    fireEvent.keyDown(textarea, { key: "Enter" });
    await act(async () => {});
    expect(posts).toBe(1);

    release(new Response(
      JSON.stringify({ accepted: true, compacted: false, result: { changed: false, mode: "overview", reason: "没有新的可压缩区段（保留最近 10 条消息）" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    expect(await screen.findByText(/没有新的可压缩区段/)).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it("compacted=true 时不重复 toast（由 context.compacted 事件负责）", async () => {
    installAppFetchMock({ session, models: [] });
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/api/sessions/s1/messages")) {
        return new Response(JSON.stringify({ accepted: true, compacted: true, result: { changed: true, mode: "vault" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    });

    renderWithClient(<App />);
    const textarea = (await waitFor(() => {
      const element = document.getElementById("composer-input");
      expect(element).not.toBeNull();
      return element;
    })) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/compact" } });
    // 同上：第一次 Enter 选中补全项，第二次发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    // 等待请求完成（草稿被清空即 onSuccess 已执行）
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(screen.queryByText(/无需压缩|没有新的可压缩区段/)).not.toBeInTheDocument();
  });
});
