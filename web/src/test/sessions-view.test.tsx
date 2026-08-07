import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { Session } from "../lib/contracts";
import { api } from "../lib/api";
import { uiStore } from "../app/ui-store";
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

function renderView(sessions: Session[] | undefined, overrides: { currentId?: string; agentStates?: Record<string, string>; onSelect?: (id: string) => void } = {}) {
  return renderWithClient(
    <SessionsView
      sessions={sessions}
      currentId={overrides.currentId}
      agentStates={overrides.agentStates ?? {}}
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

  it("重命名：未编辑提交不调接口；Esc 取消", () => {
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
  });

  it("重命名：清空标题提交发送空串（清除标题覆盖）", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "自定义标题" })]);
    fireEvent.click(screen.getByRole("button", { name: "重命名 自定义标题" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { title: "" }));
  });

  it("置顶/取消置顶调用 patchSession pinned", async () => {
    const patch = vi.spyOn(api, "patchSession").mockResolvedValue(makeSession("a"));
    renderView([makeSession("a", { title: "普通" }), makeSession("b", { title: "已置顶", pinned: true })]);
    fireEvent.click(screen.getByRole("button", { name: "置顶 普通" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { pinned: true }));
    fireEvent.click(screen.getByRole("button", { name: "取消置顶 已置顶" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("b", { pinned: false }));
  });

  it("删除按钮打开删除确认（ui.setDeleteTarget）", () => {
    renderView([makeSession("a", { title: "要删的" })]);
    fireEvent.click(screen.getByRole("button", { name: "删除会话 要删的" }));
    expect(uiStore.get().deleteTarget).toBe("a");
  });

  it("新建会话按钮打开新建对话框（ui.setNewSessionOpen）", () => {
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(uiStore.get().newSessionOpen).toBe(true);
  });

  it("设置按钮打开设置对话框（ui.openSettings）", () => {
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(uiStore.get().settingsOpen).toBe(true);
  });

  it("主题切换按钮写入偏好（localStorage owc-theme）", () => {
    renderView([]);
    fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
    expect(["light", "dark"]).toContain(window.localStorage.getItem("owc-theme"));
  });

  it("导入会话：选择文件后调用 importSession，成功提示并选中导入会话", async () => {
    const imported = makeSession("imported", { title: "导入的会话" });
    const spy = vi.spyOn(api, "importSession").mockResolvedValue(imported);
    const { container } = renderView([]);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["{}\n"], "session.jsonl", { type: "application/x-ndjson" })] } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(uiStore.get().sessionId).toBe("imported"));
    expect(uiStore.get().notice?.text).toBe("已导入会话「导入的会话」");
  });

  it("导入失败时提示错误（ui.notify error）", async () => {
    vi.spyOn(api, "importSession").mockRejectedValue(new Error("格式不对"));
    const { container } = renderView([]);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["bad"], "bad.jsonl")] } });
    await waitFor(() => expect(uiStore.get().notice?.kind).toBe("error"));
    expect(uiStore.get().notice?.text).toBe("格式不对");
  });
});
