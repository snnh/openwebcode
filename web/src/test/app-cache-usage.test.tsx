import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeContextView, makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const session = makeSession({ title: "缓存测试作业" });

const context = makeContextView({
  ledger: {
    usage: { inputTokens: 26_000, outputTokens: 80, cacheRead: 74_000, cacheWrite: 8_000 },
    cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
    entries: [],
  },
});

setupStubWebSocket();

describe("App 缓存命中率", () => {
  it("context.usage 事件驱动 JobHeader 缓存命中 badge", async () => {
    installAppFetchMock({ session, context });
    renderApp();

    // 会话加载完成前没有 badge（标题同时出现在会话列表与 JobHeader）
    await screen.findAllByText("缓存测试作业");
    expect(screen.queryByTestId("cache-usage")).toBeNull();

    act(() => {
      emitEvent(lastSocket(), "context.usage", {
        inputTokens: 21_000,
        outputTokens: 500,
        cacheRead: 98_000,
        cacheWrite: 12_000,
        cost: { priced: false },
        sessionCost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      });
    });

    // badge 出现即可；命中率文案与 tooltip 明细由 job-header.test.tsx 覆盖
    expect(await screen.findByTestId("cache-usage")).toBeTruthy();
  });
});
