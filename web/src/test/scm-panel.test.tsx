import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScmPanel } from "../components/panels/ScmPanel";
import { api, ApiError } from "../lib/api";
import type { ScmDiff, ScmStatus, ScmWorktree } from "../lib/contracts";

const status: ScmStatus = {
  isRepo: true,
  branch: "main",
  ahead: 2,
  behind: 1,
  staged: [{ path: "src/staged.ts", code: "M " }],
  unstaged: [
    { path: "src/app.ts", code: " M" },
    { path: "README.md", code: " D" },
  ],
  untracked: [{ path: "notes.txt", code: "??" }],
  totals: { staged: 1, unstaged: 2, untracked: 1 },
  truncated: false,
};

const diff: ScmDiff = {
  isRepo: true,
  stat: " src/app.ts | 2 +-",
  diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;",
  totalBytes: 120,
  truncated: false,
};

const worktrees: ScmWorktree[] = [{ name: "wt-feature", path: "/tmp/wt-feature", branch: "feature", createdAt: "2026-07-25T00:00:00.000Z", exists: true }];

function renderPanel(onNotice = vi.fn()): { onNotice: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScmPanel sessionId="s1" onNotice={onNotice} />
    </QueryClientProvider>,
  );
  return { onNotice };
}

function mockStatus(value: ScmStatus = status): void {
  vi.spyOn(api, "scmStatus").mockResolvedValue(value);
  vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
}

describe("ScmPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("按 staged/unstaged/untracked 分组渲染，显示分支与 ahead/behind", async () => {
    mockStatus();
    renderPanel();

    expect(await screen.findByText("已暂存的更改")).toBeInTheDocument();
    expect(screen.getByText("更改")).toBeInTheDocument();
    expect(screen.getByText("未跟踪的文件")).toBeInTheDocument();
    expect(screen.getByText("更改").parentElement?.textContent).toContain("2");
    expect(screen.getByText("src/staged.ts")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByLabelText("领先 2 个提交")).toBeInTheDocument();
    expect(screen.getByLabelText("落后 1 个提交")).toBeInTheDocument();
  });

  it("工作区干净时显示空态", async () => {
    mockStatus({ isRepo: true, branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], totals: { staged: 0, unstaged: 0, untracked: 0 }, truncated: false });
    renderPanel();
    expect(await screen.findByText(/工作区干净/)).toBeInTheDocument();
  });

  it("非 git 仓库（isRepo=false）时给出降级提示", async () => {
    mockStatus({ isRepo: false, staged: [], unstaged: [], untracked: [], totals: { staged: 0, unstaged: 0, untracked: 0 }, truncated: false });
    renderPanel();
    expect(await screen.findByText(/不是 git 仓库/)).toBeInTheDocument();
  });

  it("git 状态接口报错时给出降级提示", async () => {
    vi.spyOn(api, "scmStatus").mockRejectedValue(new ApiError(400, "not a git repository"));
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderPanel();
    expect(await screen.findByText(/无法读取 git 状态/)).toBeInTheDocument();
  });

  it("点击文件查看只读 diff：按分组传递 staged/file 参数并渲染 +/- 行", async () => {
    mockStatus();
    const scmDiff = vi.spyOn(api, "scmDiff").mockResolvedValue(diff);
    renderPanel();

    fireEvent.click(await screen.findByText("src/app.ts"));
    await waitFor(() => expect(scmDiff).toHaveBeenCalledWith("s1", { staged: false, file: "src/app.ts" }));
    expect(await screen.findByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
    expect(screen.getByText("-const b = 2;")).toBeInTheDocument();
    expect(screen.getByText("+const b = 3;")).toBeInTheDocument();

    fireEvent.click(screen.getByText("src/staged.ts"));
    await waitFor(() => expect(scmDiff).toHaveBeenCalledWith("s1", { staged: true, file: "src/staged.ts" }));
  });

  it("diff 截断时只显示 stat 并提示完整内容在 artifact", async () => {
    mockStatus();
    vi.spyOn(api, "scmDiff").mockResolvedValue({ isRepo: true, stat: " src/big.ts | 900 ++++", totalBytes: 1048576, truncated: true, artifactId: "artifact-123" });
    renderPanel();

    fireEvent.click(await screen.findByText("src/app.ts"));
    expect(await screen.findByText(/仅显示统计/)).toBeInTheDocument();
    expect(screen.getByText(/src\/big\.ts \| 900/)).toBeInTheDocument();
    expect(screen.getByText("artifact-123")).toBeInTheDocument();
    expect(screen.queryByText("@@ -1,2 +1,2 @@")).not.toBeInTheDocument();
  });

  it("提交辅助：向会话下发请 agent 执行 git_commit 的消息，不直接调写接口", async () => {
    mockStatus();
    const sendMessage = vi.spyOn(api, "sendMessage").mockResolvedValue({ accepted: true });
    const { onNotice } = renderPanel();

    const input = await screen.findByLabelText("提交信息");
    fireEvent.change(input, { target: { value: "fix: correct parser" } });
    fireEvent.click(screen.getByRole("button", { name: /提交（需确认）/ }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const [sessionId, content] = sendMessage.mock.calls[0];
    expect(sessionId).toBe("s1");
    expect(content).toContain("git_commit");
    expect(content).toContain("fix: correct parser");
    expect(content).toContain("权限");
    // 提交前提示需确认；下发成功后清空输入框
    expect(screen.getByText(/需经你确认/)).toBeInTheDocument();
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("确认"));
  });

  it("提交按钮在提交信息为空时禁用", async () => {
    mockStatus();
    renderPanel();
    await screen.findByLabelText("提交信息");
    expect(screen.getByRole("button", { name: /提交（需确认）/ })).toBeDisabled();
  });

  it("worktree 列表展示与创建", async () => {
    mockStatus();
    vi.spyOn(api, "scmWorktrees").mockResolvedValue(worktrees);
    const create = vi.spyOn(api, "scmCreateWorktree").mockResolvedValue({ name: "wt-2", path: "/tmp/wt-2", branch: "feature-2", createdAt: "2026-07-25T00:00:00.000Z", exists: true });
    renderPanel();

    expect(await screen.findByText("wt-feature")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("新分支名"), { target: { value: "feature-2" } });
    fireEvent.click(screen.getByRole("button", { name: /创建 worktree/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("s1", { branch: "feature-2" }));
  });

  it("清理 worktree 需先确认，确认后才按 name 调 DELETE（带 force）", async () => {
    mockStatus();
    vi.spyOn(api, "scmWorktrees").mockResolvedValue(worktrees);
    const remove = vi.spyOn(api, "scmDeleteWorktree").mockResolvedValue({ removed: true, name: "wt-feature" });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "清理 worktree wt-feature" }));
    expect(screen.getByText("确认清理？")).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("确认清理？")).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "清理 worktree wt-feature" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("s1", "wt-feature", { force: true }));
  });
});
