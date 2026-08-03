import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

/** 移动端 chrome 回归（≤1024px）：左上导航菜单、图标栏+面板两级导航、设置整页钻取、顶栏默认紧凑、面板标签两行折叠、状态并入标签条。 */

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

  it("导航菜单：logo 滑出竖向菜单（桌面活动栏不渲染），点视图收缩为图标栏 + 右侧面板，Esc/遮罩关闭", async () => {
    renderApp();
    // 桌面活动栏在移动端不渲染
    expect(document.querySelector(".activity-bar")).toBeNull();
    // 左上角触发钮（面板图标）触发左侧滑出菜单：两分组入口齐全
    const trigger = await screen.findByRole("button", { name: "打开导航菜单" });
    expect(trigger.querySelector("svg")).not.toBeNull();
    fireEvent.click(trigger);
    const nav = await screen.findByRole("navigation", { name: "导航菜单" });
    for (const name of ["会话", "文件", "源代码管理", "问题", "帮助与快捷键", "通知中心", "终端", "设置"]) {
      expect(within(nav).getByRole("button", { name })).toBeInTheDocument();
    }
    // Esc 关闭菜单
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "导航菜单" })).toBeNull());

    // 重新打开，点「会话」：菜单收起 → 左侧图标栏 + 右侧整屏面板
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "导航菜单" })).getByRole("button", { name: "会话" }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "导航菜单" })).toBeNull());
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).not.toBeNull());
    expect(document.querySelector(".wb-sidebar")).not.toBeNull();
    // 图标栏：纯图标入口齐全，当前视图高亮
    const rail = await screen.findByRole("navigation", { name: "导航" });
    for (const name of ["会话", "文件", "源代码管理", "问题", "帮助与快捷键", "通知中心", "终端", "设置"]) {
      expect(within(rail).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(rail).getByRole("button", { name: "会话" })).toHaveAttribute("aria-pressed", "true");
    // 切到「文件」：面板保持打开并换视图
    fireEvent.click(within(rail).getByRole("button", { name: "文件" }));
    await waitFor(() => expect(within(rail).getByRole("button", { name: "文件" })).toHaveAttribute("aria-pressed", "true"));
    expect(document.querySelector(".wb-sidebar")).not.toBeNull();
    // 再点当前视图图标：面板与图标栏一起收起
    fireEvent.click(within(rail).getByRole("button", { name: "文件" }));
    await waitFor(() => expect(document.querySelector(".wb-sidebar")).toBeNull());
    expect(screen.queryByRole("navigation", { name: "导航" })).toBeNull();
    // 再次打开，点击遮罩关闭
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "导航菜单" })).getByRole("button", { name: "会话" }));
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).not.toBeNull());
    fireEvent.click(document.querySelector(".wb-sidebar-backdrop")!);
    await waitFor(() => expect(document.querySelector(".wb-sidebar")).toBeNull());
    expect(screen.queryByRole("navigation", { name: "导航" })).toBeNull();
    // 再次打开，Esc 关闭
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "导航菜单" })).getByRole("button", { name: "会话" }));
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".wb-sidebar-backdrop")).toBeNull());
  });

  it("设置：移动端整页（分组图标轨 + 列表钻取详情，带返回）", async () => {
    renderApp();
    await screen.findByRole("combobox", { name: /消息输入框/ });
    // 经导航菜单打开设置
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "导航菜单" })).getByRole("button", { name: "设置" }));
    const dialog = (await screen.findByRole("dialog")).closest(".settings-dialog") as HTMLElement;
    expect(dialog).not.toBeNull();
    // 三栏结构：应用导航轨（与菜单同源图标）+ 设置项列表，初始为列表态（非钻取）
    expect(dialog.querySelector(".mobile-explorer-rail")).not.toBeNull();
    const rail = within(dialog).getByRole("navigation", { name: "导航" });
    // 设置内只有「设置」高亮，视图不高亮（当前所在区是设置）
    expect(within(rail).getByRole("button", { name: "设置" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rail).getByRole("button", { name: "会话" })).toHaveAttribute("aria-pressed", "false");
    expect(dialog.querySelector(".settings-layout")!.className).not.toContain("detail-open");
    // 点设置项钻取进详情
    fireEvent.click(within(dialog).getByRole("button", { name: "通用" }));
    await waitFor(() => expect(dialog.querySelector(".settings-layout")!.className).toContain("detail-open"));
    // 返回键回列表
    fireEvent.click(within(dialog).getByRole("button", { name: "返回设置列表" }));
    await waitFor(() => expect(dialog.querySelector(".settings-layout")!.className).not.toContain("detail-open"));
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

  it("面板标签两行折叠：默认只见常驻标签（上下文/时间线/成本），更多钮展开第二行", async () => {
    renderApp();
    await screen.findByRole("combobox", { name: /消息输入框/ });
    // 常驻三个；折叠区（子代理/沙盒/性能）默认不渲染第二行
    expect(screen.getByRole("button", { name: "上下文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "时间线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成本" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "性能" })).toBeNull();
    expect(document.querySelector(".panel-tabs-secondary")).toBeNull();
    // 展开第二行
    fireEvent.click(screen.getByRole("button", { name: "更多面板标签" }));
    const secondary = document.querySelector(".panel-tabs-secondary");
    expect(secondary).not.toBeNull();
    for (const name of ["子代理", "沙盒", "性能"]) {
      expect(within(secondary as HTMLElement).getByRole("button", { name })).toBeInTheDocument();
    }
    // 再点收起
    fireEvent.click(screen.getByRole("button", { name: "收起更多面板标签" }));
    expect(document.querySelector(".panel-tabs-secondary")).toBeNull();
  });
});
