import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

// 会话详情加载中的骨架屏：detail 查询挂起期间应渲染骨架而不是欢迎页
const session = makeSession({
  title: "骨架测试作业",
  messages: [{ id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建文件" }] }],
});

function installFetchMock(): { resolveDetail(): void } {
  let resolveDetail: () => void = () => undefined;
  const detailReady = new Promise<void>((resolve) => { resolveDetail = resolve; });
  installAppFetchMock({ session, models: [] });
  // 包一层挂起 detail 查询（extra 回调是同步签名，无法 await）
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) await detailReady;
    return inner(input, init);
  });
  return { resolveDetail: () => resolveDetail() };
}

setupStubWebSocket();

describe("App session loading skeleton", () => {
  it("renders the skeleton instead of the welcome screen while the detail query is in flight", async () => {
    const { resolveDetail } = installFetchMock();
    renderApp();

    expect(await screen.findByTestId("session-skeleton")).toBeTruthy();
    expect(screen.queryByText("开始一项可回滚的编码作业")).toBeNull();

    // 详情返回后骨架消失，消息轨道出现
    resolveDetail();
    expect(await screen.findByText("请创建文件")).toBeTruthy();
    expect(screen.queryByTestId("session-skeleton")).toBeNull();
  });
});
