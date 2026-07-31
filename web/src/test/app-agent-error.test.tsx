import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { SettingsView } from "../lib/contracts";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const userText = "请处理这个任务";

const session = makeSession({
  title: "错误提示测试作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] }],
});

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

function installFetchMock(overrides: { updateCheck?: unknown; settings?: unknown } = {}): void {
  installAppFetchMock({
    session,
    extra: (url, json) => {
      if (url.endsWith("/api/extensions")) return json([]);
      if (url.endsWith("/api/settings")) return json(overrides.settings ?? settingsView);
      if (url.endsWith("/api/update-check")) return json(overrides.updateCheck ?? updateAvailable);
      if (url.endsWith("/api/health")) return json({ status: "ok" });
      if (url.endsWith("/api/version")) return json({ server: "0.7.0", core: "0.7.0" });
      return undefined;
    },
  });
}

setupStubWebSocket();

describe("App agent.error 可操作提示与新版本通知", () => {
  beforeEach(() => {
    // jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
  });

  async function renderLoadedApp(): Promise<StubSocket> {
    renderApp();
    // 等会话详情加载完成（用户消息渲染进轨道），确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return lastSocket();
  }

  it("agent.error 按 kind 渲染提示与设置深链，toast 只给一句话摘要", async () => {
    installFetchMock();
    const socket = await renderLoadedApp();

    act(() => {
      emitEvent(socket, "agent.error", { message: "invalid api key", kind: "authentication", retryable: false });
    });

    await screen.findByText("认证失败：请检查 设置 → 模型目录 中的 API Key");
    // toast 为短摘要，不粘贴原始信息
    const toast = document.querySelector(".toast");
    expect(toast?.textContent).toContain("任务失败：认证失败，请检查 API Key");
    expect(toast?.textContent).not.toContain("invalid api key");

    fireEvent.click(screen.getByRole("button", { name: "打开模型设置" }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="models"]')?.className).toContain("active");
    });
  });

  it("发现新版本时通知一次（按版本去重），点击跳转设置服务信息页签", async () => {
    installFetchMock();
    const socket = await renderLoadedApp();

    // 打开通知中心，应有一条新版本通知
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /通知中心（1 条未读）/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /通知中心（1 条未读）/ }));
    await screen.findByText(/发现新版本 v9\.9\.9/);

    // 触发 settings 失效重取（同一版本），不应再次通知
    act(() => {
      emitEvent(socket, "server.settings_updated", undefined);
    });
    await waitFor(async () => {
      // 等失效重取完成后仍只有一条新版本通知
      expect(screen.getAllByText(/发现新版本 v9\.9\.9/)).toHaveLength(1);
    });

    // 点击通知跳转 设置 → 服务信息
    fireEvent.click(screen.getByRole("button", { name: /发现新版本 v9\.9\.9.*（点击跳转）/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-settings-tab="info"]')?.className).toContain("active");
    });
  });

  it("更新检查未启用时不通知", async () => {
    installFetchMock({
      settings: {
        groups: [{
          id: "updateCheck",
          label: "更新检查",
          fields: [{ key: "updateCheckEnabled", label: "启用更新检查", type: "boolean", value: false, hasValue: true, source: "default", editable: true, restartRequired: false, nullable: false }],
        }],
      },
    });
    await renderLoadedApp();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: /通知中心（1 条未读）/ })).toBeNull();
  });
});
