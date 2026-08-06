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
  it("JobHeader 缓存命中 badge 显示账本会话累计命中率", async () => {
    installAppFetchMock({ session, context });
    renderApp();

    // 标题同时出现在会话列表与 JobHeader；badge 随账本查询到达而出现
    await screen.findAllByText("缓存测试作业");
    // 累计口径：74k / (26k + 74k) = 74%（来自 /context 账本，非单轮事件）
    const badge = await screen.findByTestId("cache-usage");
    expect(badge.textContent).toBe("缓存 74%");
    expect(badge.title).toContain("累计缓存读取 74k");

    // context.usage 事件失效账本查询后 badge 保持（重取同一账本）
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
    expect(await screen.findByTestId("cache-usage")).toBeTruthy();
  });
});
