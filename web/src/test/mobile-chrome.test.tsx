import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

/** 移动端 chrome 回归（≤1024px）：抽屉遮罩、顶栏默认紧凑、状态栏并入标签条。 */

const session = makeSession();

setupStubWebSocket();

/** matchMedia 打桩：仅 max-width 断点命中（移动端正判定），主题等其余查询不命中。 */
function mockMobileMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("移动端 chrome", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op */ };
    mockMobileMatchMedia();
    installAppFetchMock({ session, models: [] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("侧栏抽屉：打开出现遮罩，点击遮罩关闭；再次打开后 Esc 关闭", async () => {
    renderApp();
    // 活动栏「会话」按钮在移动端打开抽屉
    fireEvent.click(await screen.findByRole("button", { name: "会话" }));
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).not.toBeNull());
    expect(document.querySelector(".wb-sidebar")).not.toBeNull();
    // 点击遮罩关闭
    fireEvent.click(document.querySelector(".wb-sidebar-backdrop")!);
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).toBeNull());
    expect(document.querySelector(".wb-sidebar")).toBeNull();
    // 再次打开，Esc 关闭
    fireEvent.click(screen.getByRole("button", { name: "会话" }));
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).toBeNull());
  });

  it("顶栏默认紧凑（无本地记录时）：下拉默认收起，点展开后出现", async () => {
    renderApp();
    // 紧凑态：沙盒下拉默认不渲染
    await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(screen.queryByRole("combobox", { name: "沙盒模式" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开顶栏" }));
    expect(await screen.findByRole("combobox", { name: "沙盒模式" })).toBeInTheDocument();
  });

  it("本地已有顶栏开合记录时以用户选择为准", async () => {
    window.localStorage.setItem("owc-header-collapsed", "0");
    renderApp();
    // 用户显式展开过：即使移动端也保持展开
    expect(await screen.findByRole("combobox", { name: "沙盒模式" })).toBeInTheDocument();
  });

  it("状态栏并入面板标签条：不再渲染独立 session-status-bar，状态点在标签条内", async () => {
    renderApp();
    await screen.findByRole("combobox", { name: /消息输入框/ });
    expect(document.querySelector(".session-status-bar")).toBeNull();
    // 面板标签条内出现并入的会话状态（状态点 + 模式 + 模型）
    const panelStatus = document.querySelector(".panel-tabs .panel-status");
    expect(panelStatus).not.toBeNull();
    expect(panelStatus!.textContent).toContain(session.model);
  });
});
