import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

/**
 * 新 App 外壳冒烟：装配层（wiring/queries/stores）+ 工作台 + 聊天区 + Composer 整体渲染。
 * 细的组件行为由各自组件测试覆盖，这里只验证「接起来能跑」。
 */

const session = makeSession({
  id: "s1",
  title: "冒烟测试作业",
  messages: [
    { id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建文件" }] },
    { id: "m2", role: "assistant", createdAt: "2026-07-17T00:00:01.000Z", content: [{ type: "text", text: "好的，已完成。" }] },
  ],
});

setupStubWebSocket();

describe("App 外壳冒烟", () => {
  it("渲染工作台：会话列表 + 消息 + Composer + 状态条", async () => {
    installAppFetchMock({ session, models: [] });
    renderWithClient(<App />);

    // 会话头与消息轨道
    expect(await screen.findByText("请创建文件")).toBeInTheDocument();
    expect(await screen.findByText("好的，已完成。")).toBeInTheDocument();
    // Composer（id 锚点）
    await waitFor(() => expect(document.getElementById("composer-input")).not.toBeNull());
    // 会话列表出现该会话（侧栏或移动抽屉，按视口而定——至少存在一处标题）
    expect(screen.getAllByText("冒烟测试作业").length).toBeGreaterThan(0);
  });

  it("详情加载中渲染骨架而非欢迎页", async () => {
    let resolveDetail: () => void = () => undefined;
    const detailReady = new Promise<void>((resolve) => { resolveDetail = resolve; });
    installAppFetchMock({ session, models: [] });
    const inner = globalThis.fetch;
    // 包一层挂起 detail 查询
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) await detailReady;
      return inner(input, init);
    });

    renderWithClient(<App />);
    expect(await screen.findByTestId("session-skeleton")).toBeInTheDocument();
    resolveDetail();
    expect(await screen.findByText("请创建文件")).toBeInTheDocument();
  });
});
