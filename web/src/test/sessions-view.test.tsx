import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Session } from "../lib/contracts";
import { api } from "../lib/api";
import { ui, uiStore } from "../app/ui-store";
import { SessionsView } from "../workbench/SessionsView";
import { makeSession as makeFixtureSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";
const noop = (): void => undefined;
const session = (id: string, overrides: Partial<Session> = {}): Session => makeFixtureSession({ id, title: `会话 ${id}`, ...overrides });
const titlesOf = (): string[] => screen.getAllByText(/^会话 [abc]$/).map((node) => node.textContent ?? "");
function renderView(
  sessions: Session[] | undefined,
  overrides: { currentId?: string; agentStates?: Record<string, string>; attention?: Record<string, { permissions: number; interactions: number }>; onSelect?: (id: string) => void } = {},
) {
  return renderWithClient(
    <SessionsView sessions={sessions} currentId={overrides.currentId} agentStates={overrides.agentStates ?? {}} attention={overrides.attention ?? {}} onSelect={overrides.onSelect ?? noop} />,
  );
}
beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, deleteTarget: undefined, notice: undefined, notifications: [] });
});
describe("SessionsView 列表与选中", () => {
  it("渲染置顶在前、仅 streaming 计运行中、待回答角标、点击回调；加载中/空态/无匹配三态与搜索过滤且 Esc 清空", () => {
    const onSelect = vi.fn();
    renderView([session("a"), session("b", { pinned: true }), session("c")], { currentId: "b", agentStates: { a: "streaming", b: "idle", c: "failed" }, attention: { c: { permissions: 1, interactions: 2 } }, onSelect });
    expect(titlesOf()).toEqual(["会话 b", "会话 a", "会话 c"]);
    // busy 判定走 lib/agent-state：仅 streaming 计运行中
    expect(screen.getAllByRole("status", { name: "运行中" })).toHaveLength(1);
    expect(screen.getByTitle("等待你操作：待批准 1 · 待回答 2")).toHaveTextContent("3");
    fireEvent.click(screen.getByText("会话 a")); expect(onSelect).toHaveBeenCalledWith("a");
    cleanup();
    const loading = renderView(undefined); expect(screen.getByText("加载中…")).toBeInTheDocument();
    loading.unmount();
    const empty = renderView([]); expect(screen.getByText("还没有会话")).toBeInTheDocument();
    empty.unmount();
    renderView([session("a", { title: "修 bug" }), session("b", { title: "写文档", provider: "openai" })]);
    const search = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(search, { target: { value: "openai" } }); expect(screen.queryByText("修 bug")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "不存在" } }); expect(screen.getByText("无匹配会话")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" }); expect(screen.getByText("修 bug")).toBeInTheDocument();
  });
  it("重命名 Enter 提交 trim 后标题、Esc 不调；置顶与取消置顶调 patch；工具栏删除确认/新建/设置/主题持久化", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(session("a"));
    renderView([session("a", { title: "旧标题" }), session("b", { title: "已置顶", pinned: true })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "改动未提交" } }); fireEvent.keyDown(input, { key: "Escape" });
    expect(patch).not.toHaveBeenCalled(); expect(screen.getByText("旧标题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const retry = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(retry, { target: { value: "  新标题  " } }); fireEvent.keyDown(retry, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { title: "新标题" }));
    fireEvent.click(screen.getByRole("button", { name: "置顶 旧标题" })); await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { pinned: true }));
    fireEvent.click(screen.getByRole("button", { name: "取消置顶 已置顶" })); await waitFor(() => expect(patch).toHaveBeenCalledWith("b", { pinned: false }));
    fireEvent.click(screen.getByRole("button", { name: "删除会话 旧标题" })); expect(uiStore.get().deleteTarget).toBe("a");
    fireEvent.click(screen.getByRole("button", { name: "新建会话" })); expect(uiStore.get().newSessionOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "设置" })); expect(uiStore.get().settingsOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "切换主题" })); expect(["light", "dark"]).toContain(window.localStorage.getItem("owc-theme"));
  });
  it("分组渲染（未分组恒在最后，单项退化为「全部会话」）+ 折叠记忆写入 localStorage 后沿用", () => {
    const { container } = renderView([session("a", { title: "前端一", group: "前端" }), session("b", { title: "后端一", group: "后端" }), session("c", { title: "散装" })]);
    expect([...container.querySelectorAll(".session-group-name")].map((node) => node.textContent)).toEqual(["后端", "前端", "未分组"]);
    cleanup();
    const { container: plain } = renderView([session("a", { title: "唯一" })]);
    expect([...plain.querySelectorAll(".session-group-name")].map((node) => node.textContent)).toEqual(["全部会话"]);
    cleanup();
    const grouped = renderView([session("a", { title: "前端一", group: "前端" })]);
    fireEvent.click(grouped.container.querySelector(".session-group-toggle")!);
    expect(window.localStorage.getItem("owc-session-groups-collapsed")).toContain("前端");
    cleanup();
    renderView([session("a", { title: "前端一", group: "前端" })]); expect(screen.queryByText("前端一")).toBeNull();
  });
  it("移动到分组（选已有组/移出分组/新组名）、分组重命名、删除分组把组内会话移回未分组", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(session("a"));
    renderView([session("a", { title: "要归组的", group: "前端" }), session("b", { title: "参考", group: "后端" })]);
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" })); fireEvent.click(screen.getByRole("menuitem", { name: "后端" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "后端" }));
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" })); fireEvent.click(screen.getByRole("menuitem", { name: "移出分组" }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("a", { group: "" }));
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" }));
    const input = screen.getByRole("textbox", { name: "新分组名" });
    fireEvent.change(input, { target: { value: "新组" } }); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("a", { group: "新组" }));
    cleanup();
    renderView([session("a", { title: "甲", group: "前端" }), session("b", { title: "乙", group: "前端" })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名分组 前端" }));
    const rename = screen.getByRole("textbox", { name: "重命名分组" });
    fireEvent.change(rename, { target: { value: "客户端" } }); fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "客户端" }));
    cleanup();
    renderView([session("a", { title: "甲", group: "前端" }), session("b", { title: "乙", group: "前端" })]);
    fireEvent.click(screen.getByRole("button", { name: "删除分组 前端" })); fireEvent.click(await screen.findByRole("button", { name: "删除分组" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "" })); expect(patch).toHaveBeenCalledWith("b", { group: "" });
  });
  it("归档调 patch；服务端 409 提示且不留假状态；已归档区默认折叠并可取消归档", async () => {
    const notify = vi.spyOn(ui, "notify");
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(session("a"));
    renderView([session("a", { title: "待归档" })]);
    fireEvent.click(screen.getByRole("button", { name: "归档 待归档" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { archived: true }));
    cleanup();
    vi.spyOn(api, "patchSession").mockRejectedValue(new Error("Session is running; stop it before archiving"));
    renderView([session("a", { title: "运行中的" })]);
    fireEvent.click(screen.getByRole("button", { name: "归档 运行中的" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("stop it before archiving"), "error"));
    cleanup();
    const archived = renderView([session("a", { title: "老会话", archived: true })]);
    expect(archived.container.querySelector(".session-group[data-collapsed]")).not.toBeNull();
    expect(screen.queryByText("老会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已归档/ })); fireEvent.click(screen.getByRole("button", { name: "取消归档 老会话" }));
    await waitFor(() => expect(api.patchSession).toHaveBeenLastCalledWith("a", { archived: false }));
  });
  it("多选批量：全选只覆盖当前列表、批量归档/删除确认逐个删/批量移动分组/批量取消归档", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(session("a"));
    const remove = vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
    renderView([session("a", { title: "甲" }), session("b", { title: "乙" }), session("c", { title: "丙", archived: true })]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" }));
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全选" })); expect(screen.getByText("已选 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { archived: true })); expect(patch).toHaveBeenCalledWith("b", { archived: true });
    fireEvent.click(screen.getByRole("button", { name: "全选" })); fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/将删除 2 个会话：甲、乙。/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "删除" }).at(-1)!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("a")); expect(remove).toHaveBeenCalledWith("b");
    cleanup();
    renderView([session("a", { title: "甲", group: "前端" }), session("c", { title: "丙", archived: true })]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" })); fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "批量移动到分组" })); fireEvent.click(screen.getByRole("menuitem", { name: "移出分组（未分组）" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "" }));
    cleanup();
    renderView([session("c", { title: "丙", archived: true })]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" })); fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择会话 丙" })); fireEvent.click(screen.getByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("c", { archived: false }));
  });
});
