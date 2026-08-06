import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const session = makeSession({ title: "水位测试作业" });

setupStubWebSocket();

describe("App 上下文窗口水位", () => {
  it("context.watermark 事件驱动 JobHeader 窗口占用 meter", async () => {
    installAppFetchMock({ session });
    renderApp();

    // 会话加载完成前没有 meter（标题同时出现在会话列表与 JobHeader）
    await screen.findAllByText("水位测试作业");
    expect(screen.queryByTestId("window-usage")).toBeNull();

    act(() => {
      emitEvent(lastSocket(), "context.watermark", {
        estimatedTokens: 45_000,
        contextWindow: 128_000,
        maxOutput: 8_000,
        workingBudget: 120_000,
        utilization: 0.363,
        segments: { system: 1_000, compactionSummary: 0, toolResults: 18_000, messages: 24_000, repoMap: 2_000, other: 0 },
        pinnedTokens: 0,
        buildMs: 0.8,
        incremental: true,
      });
    });

    const meter = await screen.findByTestId("window-usage");
    expect(meter.textContent).toContain("45k/128k");
    expect(meter.textContent).toContain("36%");
    expect(meter.dataset.level).toBe("normal");
  });
});
