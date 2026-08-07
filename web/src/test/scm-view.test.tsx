import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../lib/api";
import type { ScmDiff, ScmStatus, ScmWorktree } from "../lib/contracts";
import { uiStore } from "../app/ui-store";
import { auxViewsStore } from "../workbench/aux-views";
import { ScmView } from "../workbench/sidebar/ScmView";
import { renderWithClient } from "./helpers/with-client";

const cleanStatus: ScmStatus = {
  isRepo: true,
  branch: "main",
  staged: [],
  unstaged: [],
  untracked: [],
  totals: { staged: 0, unstaged: 0, untracked: 0 },
  truncated: false,
};

const dirtyStatus: ScmStatus = {
  ...cleanStatus,
  branch: "feature",
  ahead: 2,
  staged: [{ path: "src/staged.ts", code: "M " }],
  unstaged: [{ path: "src/dirty.ts", code: " M" }],
  untracked: [{ path: "notes.txt", code: "??" }],
  totals: { staged: 1, unstaged: 1, untracked: 1 },
};

const worktree: ScmWorktree = { name: "wt-1", path: "/tmp/wt-1", branch: "wt-branch", createdAt: "2026-01-01T00:00:00Z", exists: true };

const diff: ScmDiff = {
  isRepo: true,
  stat: " src/dirty.ts | 2 +-",
  diff: "diff --git a/src/dirty.ts b/src/dirty.ts\n-old\n+new",
  totalBytes: 50,
  truncated: false,
};

function renderView(sessionId?: string) {
  return renderWithClient(<ScmView sessionId={sessionId} />);
}

describe("ScmView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
    uiStore.set({ notice: undefined, notifications: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderView(undefined);
    expect(screen.getByText("选择会话以查看源代码管理。")).toBeInTheDocument();
  });

  it("状态读取失败显示行内错误（role=alert）", async () => {
    vi.spyOn(api, "scmStatus").mockRejectedValue(new ApiError(500, "boom"));
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderView("s1");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取 git 状态（该会话目录可能不是 git 仓库）：boom");
  });

  it("非 git 仓库显示空态", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue({ ...cleanStatus, isRepo: false, branch: undefined });
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderView("s1");
    expect(await screen.findByText("该会话目录不是 git 仓库。")).toBeInTheDocument();
  });

  it("干净工作区显示分支与「没有变更」", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderView("s1");
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("工作区干净，没有变更。")).toBeInTheDocument();
  });

  it("分组渲染 staged/unstaged/untracked，行内 stage 调用接口", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    vi.spyOn(api, "scmDiff").mockResolvedValue(diff);
    const stage = vi.spyOn(api, "scmStage").mockResolvedValue({ staged: ["src/dirty.ts"] });
    renderView("s1");

    expect(await screen.findByText("已暂存的更改")).toBeInTheDocument();
    expect(screen.getByText("更改")).toBeInTheDocument();
    expect(screen.getByText("未跟踪的文件")).toBeInTheDocument();
    expect(screen.getByLabelText("领先 2 个提交")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "暂存 src/dirty.ts" }));
    await waitFor(() => expect(stage).toHaveBeenCalledWith("s1", ["src/dirty.ts"]));
  });

  it("放弃更改需行内二次确认，确认后调用 discard(force=false)", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    const discard = vi.spyOn(api, "scmDiscard").mockResolvedValue({ discarded: ["src/dirty.ts"] });
    renderView("s1");

    fireEvent.click(await screen.findByRole("button", { name: "放弃 src/dirty.ts 的更改" }));
    expect(screen.getByText("确认放弃更改？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("s1", ["src/dirty.ts"], false));
  });

  it("点击变更项展示只读 diff；「在 diff 视图中打开」写入 auxViews", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    vi.spyOn(api, "scmDiff").mockResolvedValue(diff);
    renderView("s1");

    fireEvent.click(await screen.findByText("src/dirty.ts"));
    expect(await screen.findByText("-old")).toBeInTheDocument();
    expect(screen.getByText("+new")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "在 diff 视图中打开（支持 hunk 接受/拒绝）" }));
    expect(auxViewsStore.get().diff).toEqual({ source: "scm", path: "src/dirty.ts", staged: false });
  });

  it("未跟踪文件点击后读取文件内容预览", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    const readFile = vi.spyOn(api, "readFile").mockResolvedValue({ content: "草稿内容", encoding: "utf-8", truncated: false, revision: "r1" });
    renderView("s1");

    fireEvent.click(await screen.findByText("notes.txt"));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "notes.txt"));
    expect(await screen.findByText("草稿内容")).toBeInTheDocument();
  });

  it("提交辅助：下发 agent 消息并提示", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendMessage").mockResolvedValue({ accepted: true });
    renderView("s1");

    fireEvent.change(await screen.findByRole("textbox", { name: "提交信息" }), { target: { value: "修复问题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交（需确认）" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toBe("s1");
    expect(send.mock.calls[0]?.[1]).toContain("修复问题");
    await waitFor(() => expect(uiStore.get().notice?.text).toBe("已下发提交请求，agent 执行前会请求你确认。"));
  });

  it("历史折叠区：展开后拉取并渲染提交记录", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    const log = vi.spyOn(api, "scmLog").mockResolvedValue({
      commits: [{ hash: "abcdef123456", shortHash: "abcdef1", author: "alice", relTime: "2 小时前", subject: "初始提交" }],
    });
    renderView("s1");

    expect(log).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));
    expect(await screen.findByText("初始提交")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
  });

  it("worktree：创建、清理（二次确认）、合回成功提示", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([worktree]);
    const create = vi.spyOn(api, "scmCreateWorktree").mockResolvedValue(worktree);
    const remove = vi.spyOn(api, "scmDeleteWorktree").mockResolvedValue({ removed: true, name: "wt-1" });
    const merge = vi.spyOn(api, "scmMergeWorktree").mockResolvedValue({ merged: true, conflicts: [], strategy: "merge", branch: "main" });
    renderView("s1");

    expect(await screen.findByText("wt-1")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "新分支名" }), { target: { value: "topic" } });
    fireEvent.click(screen.getByRole("button", { name: /创建 worktree/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("s1", { branch: "topic" }));

    fireEvent.click(screen.getByRole("button", { name: "清理 worktree wt-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("s1", "wt-1", { force: true }));

    fireEvent.click(screen.getByRole("button", { name: "合回 worktree wt-1" }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith("s1", "wt-1"));
    await waitFor(() => expect(uiStore.get().notice?.text).toBe("已将 wt-1 合回 main。"));
  });

  it("worktree 合回冲突：展示冲突文件列表", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([worktree]);
    vi.spyOn(api, "scmMergeWorktree").mockResolvedValue({ merged: false, conflicts: ["src/a.ts"], strategy: "merge", branch: "main" });
    renderView("s1");

    fireEvent.click(await screen.findByRole("button", { name: "合回 worktree wt-1" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("合回 wt-1 的冲突文件（1）");
    expect(alert).toHaveTextContent("src/a.ts");
  });
});
