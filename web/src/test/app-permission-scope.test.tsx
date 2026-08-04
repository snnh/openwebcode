import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { emitEvent, lastSocket, setupStubWebSocket, type StubSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const userText = "请处理这个任务";

const session = makeSession({
  title: "权限测试作业",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-28T00:00:00.000Z", content: [{ type: "text", text: userText }] }],
});

function installFetchMock(): void {
  installAppFetchMock({
    session,
    models: [],
    extra: (url, json) => {
      if (url.endsWith("/api/extensions")) return json([]);
      if (url.endsWith("/api/settings")) return json({ groups: [] });
      if (url.endsWith("/api/update-check")) return json({ snapshot: { latestVersion: "0.7.0", isNewer: false, htmlUrl: "", publishedAt: "", checkedAt: "" } });
      if (url.endsWith("/api/health")) return json({ status: "ok" });
      return undefined;
    },
  });
}

setupStubWebSocket();

describe("App permission.request 按会话隔离", () => {
  async function renderLoadedApp(): Promise<StubSocket> {
    installFetchMock();
    renderApp();
    // 等会话详情加载完成，确保 currentId 已设置、WS handler 闭包为最新
    await screen.findByText(userText);
    return lastSocket();
  }

  it("其他会话的 permission.request 不在当前轨道渲染权限卡，当前会话的正常渲染", async () => {
    const socket = await renderLoadedApp();

    // 其他会话（s2）的权限请求：不得污染当前会话的待决列表与轨道
    act(() => {
      emitEvent(socket, "permission.request", { requestId: "req-foreign", tool: "run_command", input: { command: "echo foreign" } }, { sessionId: "s2" });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // 当前会话的权限请求：正常渲染权限卡
    act(() => {
      emitEvent(socket, "permission.request", { requestId: "req-own", tool: "run_command", input: { command: "echo own" } });
    });
    const card = await screen.findByRole("alertdialog");
    expect(card).toHaveTextContent("run_command");
    expect(card).toHaveTextContent("echo own");
  });

  it("permission.resolved 撤掉权限卡（其他客户端响应 / 中断 abort 场景）", async () => {
    const socket = await renderLoadedApp();
    act(() => {
      emitEvent(socket, "permission.request", { requestId: "req-own", tool: "run_command", input: { command: "echo own" } });
    });
    const card = await screen.findByRole("alertdialog");
    expect(card).toHaveTextContent("run_command");

    // 服务端在挂起消失时广播 permission.resolved：本地即时权限卡必须随之撤掉，不得悬挂
    act(() => {
      emitEvent(socket, "permission.resolved", { requestId: "req-own" });
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("resync.required 清空本地权限卡并以服务端真相对齐幽灵 busy 态", async () => {
    const socket = await renderLoadedApp();
    act(() => {
      emitEvent(socket, "permission.request", { requestId: "req-stale", tool: "run_command", input: { command: "echo stale" } });
      emitEvent(socket, "agent.state", { state: "streaming" });
    });
    await screen.findByRole("alertdialog");
    // JobHeader 的 busy 徽章（多处 UI 都渲染状态文案，这里锁定 header 徽章）
    await waitFor(() => expect(document.querySelector(".job-header .pill.accent")).not.toBeNull());

    // 事件缺口/服务端重启触发 resync：本地权限卡清空（由服务端列表重建）；
    // /run 返回 404（服务端无活跃 run）时本地残留的 busy 态必须回落。
    act(() => {
      emitEvent(socket, "resync.required", { latestSeq: 0, reason: "slow_client" });
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.querySelector(".job-header .pill")).toBeNull());
  });
});
