import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Session } from "../lib/contracts";
import { api } from "../lib/api";
import { ui, uiStore } from "../app/ui-store";
import { SessionsView } from "../workbench/SessionsView";
import { renderWithClient } from "./helpers/with-client";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `会话 ${id}`,
    cwd: `D:/work/${id}`,
    provider: "anthropic",
    model: "claude",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = (): void => undefined;

function renderView(
  sessions: Session[] | undefined,
  overrides: { currentId?: string; agentStates?: Record<string, string>; attention?: Record<string, { permissions: number; interactions: number }>; onSelect?: (id: string) => void } = {},
) {
  return renderWithClient(
    <SessionsView
      sessions={sessions}
      currentId={overrides.currentId}
      agentStates={overrides.agentStates ?? {}}
      attention={overrides.attention ?? {}}
      onSelect={overrides.onSelect ?? noop}
    />,
  );
}

describe("SessionsView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, deleteTarget: undefined, notice: undefined, notifications: [] });
  });

  it("渲染会话列表（标题 + provider · model 元信息）", () => {
    renderView([makeSession("a"), makeSession("b")]);
    expect(screen.getByText("会话 a")).toBeInTheDocument();
    expect(screen.getByText("会话 b")).toBeInTheDocument();
    expect(screen.getAllByText("anthropic · claude")).toHaveLength(2);
  });

  it("置顶会话排在前面（组内保持原顺序）", () => {
    const { container } = renderView([makeSession("a"), makeSession("b", { pinned: true }), makeSession("c")]);
    const titles = [...container.querySelectorAll(".session-title")].map((node) => node.textContent);
    expect(titles).toEqual(["会话 b", "会话 a", "会话 c"]);
  });

  it("运行中的会话显示运行点（busy 态判定走 lib/agent-state）", () => {
    renderView([makeSession("a"), makeSession("b"), makeSession("c")], { agentStates: { a: "streaming", b: "idle", c: "failed" } });
    expect(screen.getAllByRole("status", { name: "运行中" })).toHaveLength(1);
  });

  it("选中态高亮 + 点击回调 onSelect", () => {
    const onSelect = vi.fn();
    const { container } = renderView([makeSession("a"), makeSession("b")], { currentId: "b", onSelect });
    expect(container.querySelector(".session-item.active .session-title")?.textContent).toBe("会话 b");
    fireEvent.click(screen.getByText("会话 a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("加载中 / 空态 / 过滤无匹配三态文案", () => {
    const { unmount } = renderView(undefined);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    unmount();

    const second = renderView([]);
    expect(screen.getByText("还没有会话")).toBeInTheDocument();
    second.unmount();

    renderView([makeSession("a")]);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "不存在" } });
    expect(screen.getByText("无匹配会话")).toBeInTheDocument();
  });

  it("搜索框按标题/provider/model 过滤，Esc 清空", () => {
    renderView([makeSession("a", { title: "修 bug" }), makeSession("b", { title: "写文档", provider: "openai" })]);
    const search = screen.getByRole("textbox", { name: "搜索会话" });
    fireEvent.change(search, { target: { value: "openai" } });
    expect(screen.queryByText("修 bug")).not.toBeInTheDocument();
    expect(screen.getByText("写文档")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByText("修 bug")).toBeInTheDocument();
  });

  it("重命名：点按钮出现输入框，Enter 提交调用 patchSession（trim 后非空且有变化才调）", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "旧标题" })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "  新标题  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { title: "新标题" }));
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
  });

  it("重命名：未编辑不调接口、Esc 取消、清空提交空串", async () => {
    // 未编辑提交不调接口；Esc 取消
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "旧标题" })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    const again = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(again, { target: { value: "改动未提交" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "重命名会话" })).toBeNull();
    expect(screen.getByText("旧标题")).toBeInTheDocument();

    // 清空标题提交发送空串（清除标题覆盖）
    cleanup();
    const clearPatch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "自定义标题" })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 自定义标题" }));
    const clearInput = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(clearInput, { target: { value: "   " } });
    fireEvent.keyDown(clearInput, { key: "Enter" });
    await waitFor(() => expect(clearPatch).toHaveBeenCalledWith("a", { title: "" }));
  });

  it("置顶/取消置顶调用 patchSession pinned", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "普通" }), makeSession("b", { title: "已置顶", pinned: true })]);
    fireEvent.click(screen.getByRole("button", { name: "置顶 普通" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { pinned: true }));
    fireEvent.click(screen.getByRole("button", { name: "取消置顶 已置顶" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("b", { pinned: false }));
  });

  it("工具栏按钮接线：删除确认/新建/设置/主题持久化", () => {
    // 删除按钮打开删除确认（ui.setDeleteTarget）
    renderView([makeSession("a", { title: "要删的" })]);
    fireEvent.click(screen.getByRole("button", { name: "删除会话 要删的" }));
    expect(uiStore.get().deleteTarget).toBe("a");

    // 新建会话按钮打开新建对话框
    cleanup();
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(uiStore.get().newSessionOpen).toBe(true);

    // 设置按钮打开设置对话框（ui.openSettings）
    cleanup();
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(uiStore.get().settingsOpen).toBe(true);

    // 主题切换按钮写入偏好（localStorage owc-theme）
    cleanup();
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
    expect(["light", "dark"]).toContain(window.localStorage.getItem("owc-theme"));
  });

  it("导入会话：成功提示并选中；失败 ui.notify error", async () => {
    // 成功：调用 importSession，提示并选中导入会话
    const imported = makeSession("imported", { title: "导入的会话" });
    const spy = vi.spyOn(api, "importSession").mockResolvedValue(imported);
    const { container } = renderView([]);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["{}\n"], "session.jsonl", { type: "application/x-ndjson" })] } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(uiStore.get().sessionId).toBe("imported"));
    expect(uiStore.get().notice?.text).toBe("已导入会话「导入的会话」");

    // 失败：提示错误
    cleanup();
    vi.spyOn(api, "importSession").mockRejectedValue(new Error("格式不对"));
    const { container: failing } = renderView([]);
    const badInput = failing.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(badInput, { target: { files: [new File(["bad"], "bad.jsonl")] } });
    await waitFor(() => expect(uiStore.get().notice?.kind).toBe("error"));
    expect(uiStore.get().notice?.text).toBe("格式不对");
  });
});

describe("SessionsView 待回答角标", () => {
  it("有待办时显示琥珀角标与计数，hover 文案区分待批准/待回答", () => {
    const { container } = renderView([makeSession("s1", { title: "会话一" })], {
      attention: { s1: { permissions: 1, interactions: 2 } },
    });
    const badge = container.querySelector(".attention-badge")!;
    expect(badge.textContent).toContain("3");
    expect(badge.getAttribute("title")).toBe("等待你操作：待批准 1 · 待回答 2");
    // 有待办但没有运行中：不再显示运行圆点
    expect(container.querySelector(".running-dot")).toBeNull();
  });

  it("待办优先于运行圆点，两者并存时同时显示；无待办时退回运行圆点", () => {
    const { container: both } = renderView([makeSession("s1", { title: "会话一" })], {
      agentStates: { s1: "tool_running" },
      attention: { s1: { permissions: 0, interactions: 1 } },
    });
    expect(both.querySelector(".attention-badge")).not.toBeNull();
    expect(both.querySelector(".running-dot")).not.toBeNull();
    expect(both.querySelector(".attention-badge")!.getAttribute("title")).toBe("等待你操作：待回答 1");

    const { container: plain } = renderView([makeSession("s1", { title: "会话一" })], { agentStates: { s1: "tool_running" } });
    expect(plain.querySelector(".attention-badge")).toBeNull();
    expect(plain.querySelector(".running-dot")).not.toBeNull();
  });
});

describe("SessionsView 分组 / 归档 / 多选批量", () => {
  beforeEach(() => {
    // 折叠记忆存 localStorage：每个用例从干净状态开始（否则会沿用上一个用例的收起状态）
    vi.restoreAllMocks();
    window.localStorage.clear();
    uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, deleteTarget: undefined, notice: undefined, notifications: [] });
  });

  it("分组渲染：组头显示名称与数量，未分组恒在最后且带「未分组」标题", () => {
    const { container } = renderView([
      makeSession("a", { title: "前端一", group: "前端" }),
      makeSession("b", { title: "后端一", group: "后端" }),
      makeSession("c", { title: "散装" }),
    ]);
    const headers = [...container.querySelectorAll(".session-group-name")].map((node) => node.textContent);
    expect(headers).toEqual(["后端", "前端", "未分组"]);
    // 单项会话时分隔标题退化为「全部会话」，避免只有一个标题的噪音分组
    cleanup();
    const { container: plain } = renderView([makeSession("a", { title: "唯一" })]);
    expect([...plain.querySelectorAll(".session-group-name")].map((node) => node.textContent)).toEqual(["全部会话"]);
  });

  it("折叠记忆：收起某组后会话隐藏并写入 localStorage；刷新后沿用", () => {
    const { container } = renderView([makeSession("a", { title: "前端一", group: "前端" })]);
    expect(screen.getByText("前端一")).toBeInTheDocument();
    fireEvent.click(container.querySelector(".session-group-toggle")!);
    expect(container.querySelector(".session-group[data-collapsed=\"true\"]")).not.toBeNull();
    expect(window.localStorage.getItem("owc-session-groups-collapsed")).toContain("前端");

    cleanup();
    renderView([makeSession("a", { title: "前端一", group: "前端" })]);
    expect(screen.queryByText("前端一")).toBeNull();
  });

  it("移动到分组：从下拉选已有组、移出分组、输入新组名", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([
      makeSession("a", { title: "要归组的", group: "前端" }),
      makeSession("b", { title: "参考", group: "后端" }),
    ]);
    // 已有组：移到「后端」
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "后端" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "后端" }));

    cleanup();
    const patch2 = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "要归组的", group: "前端" })]);
    // 移出分组：发送空串（服务端删键）
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出分组" }));
    await waitFor(() => expect(patch2).toHaveBeenCalledWith("a", { group: "" }));

    cleanup();
    const patch3 = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "要归组的" })]);
    // 新建组：输入 + Enter
    fireEvent.click(screen.getByRole("button", { name: "移动到分组 要归组的" }));
    const input = screen.getByRole("textbox", { name: "新分组名" });
    fireEvent.change(input, { target: { value: "新组" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch3).toHaveBeenCalledWith("a", { group: "新组" }));
  });

  it("归档与取消归档：调用 patchSession；服务端 409（有活动）时提示错误且不留假状态", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "待归档" })]);
    fireEvent.click(screen.getByRole("button", { name: "归档 待归档" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { archived: true }));

    // 服务端拒绝（运行中/后台任务/终端）：错误提示原文，不静默
    cleanup();
    const notify = vi.spyOn(ui, "notify");
    const rejected = vi.spyOn(api, "patchSession").mockRejectedValue(new Error("Session is running; stop it before archiving"));
    renderView([makeSession("a", { title: "运行中的" })]);
    fireEvent.click(screen.getByRole("button", { name: "归档 运行中的" }));
    await waitFor(() => expect(rejected).toHaveBeenCalled());
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("stop it before archiving"), "error"));
  });

  it("已归档区默认折叠，展开后可取消归档", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    const { container } = renderView([makeSession("a", { title: "老会话", archived: true })]);
    const archivedGroup = container.querySelector(".session-group[data-collapsed]");
    expect(archivedGroup).not.toBeNull();
    expect(screen.queryByText("老会话")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消归档 老会话" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { archived: false }));
  });

  it("多选批量：进入多选、全选、归档与删除（删除走确认框，逐个调接口）", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    const remove = vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
    renderView([makeSession("a", { title: "甲" }), makeSession("b", { title: "乙" }), makeSession("c", { title: "丙", archived: true })]);

    // 进入多选：初始为空选，勾选框与批量条出现
    fireEvent.click(screen.getByRole("button", { name: "多选会话" }));
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toBeInTheDocument();
    expect(screen.getByText("已选 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档 甲" })).toBeNull();

    // 「全选」只覆盖当前列表（未归档）中的会话（丙是已归档，不在默认列表里）
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { archived: true }));
    expect(patch).toHaveBeenCalledWith("b", { archived: true });

    // 删除：先出确认框（列出前几个标题），确认后逐个删除（批量后复选框清空、模式保留）
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/将删除 2 个会话：甲、乙。/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "删除" }).at(-1)!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("a"));
    expect(remove).toHaveBeenCalledWith("b");
  });

  it("批量移动到组与批量取消归档：一次提交多个会话", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([
      makeSession("a", { title: "甲", group: "前端" }),
      makeSession("b", { title: "乙", group: "前端" }),
      makeSession("c", { title: "丙", archived: true }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" }));
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    // 批量移到「前端」组（已有组）+ 移出分组两条路径
    fireEvent.click(screen.getByRole("button", { name: "批量移动到分组" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "前端" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "前端" }));
    expect(patch).toHaveBeenCalledWith("b", { group: "前端" });

    cleanup();
    const patch2 = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "甲", group: "前端" }), makeSession("c", { title: "丙", archived: true })]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" }));
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "批量移动到分组" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出分组（未分组）" }));
    await waitFor(() => expect(patch2).toHaveBeenCalledWith("a", { group: "" }));

    // 已归档项：展开已归档区后勾选，批量「取消归档」
    cleanup();
    const patch3 = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("c"));
    renderView([makeSession("c", { title: "丙", archived: true })]);
    fireEvent.click(screen.getByRole("button", { name: "多选会话" }));
    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择会话 丙" }));
    fireEvent.click(screen.getByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(patch3).toHaveBeenCalledWith("c", { archived: false }));
  });

  it("分组重命名与删除分组：删除分组把组内会话移回未分组（不删会话）", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "甲", group: "前端" }), makeSession("b", { title: "乙", group: "前端" })]);

    fireEvent.click(screen.getByRole("button", { name: "重命名分组 前端" }));
    const input = screen.getByRole("textbox", { name: "重命名分组" });
    fireEvent.change(input, { target: { value: "客户端" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { group: "客户端" }));

    cleanup();
    const patch2 = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "甲", group: "前端" }), makeSession("b", { title: "乙", group: "前端" })]);
    fireEvent.click(screen.getByRole("button", { name: "删除分组 前端" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除分组" }));
    await waitFor(() => expect(patch2).toHaveBeenCalledWith("a", { group: "" }));
    expect(patch2).toHaveBeenCalledWith("b", { group: "" });
  });
});
