import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScmPanel } from "../components/panels/ScmPanel";
import { api, ApiError } from "../lib/api";
import type { ScmDiff, ScmStatus, ScmWorktree } from "../lib/contracts";
import { renderWithClient } from "./helpers/with-client";

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
  renderWithClient(<ScmPanel sessionId="s1" onNotice={onNotice} />);
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

  it("行内按钮：unstaged 组可暂存，staged 组可取消暂存，成功后刷新状态", async () => {
    mockStatus();
    const statusSpy = vi.spyOn(api, "scmStatus");
    const stage = vi.spyOn(api, "scmStage").mockResolvedValue({ staged: ["src/app.ts"] });
    const unstage = vi.spyOn(api, "scmUnstage").mockResolvedValue({ unstaged: ["src/staged.ts"] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "暂存 src/app.ts" }));
    await waitFor(() => expect(stage).toHaveBeenCalledWith("s1", ["src/app.ts"]));
    await waitFor(() => expect(statusSpy.mock.calls.length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole("button", { name: "取消暂存 src/staged.ts" }));
    await waitFor(() => expect(unstage).toHaveBeenCalledWith("s1", ["src/staged.ts"]));
  });

  it("放弃 tracked 更改需先确认，确认后调 discard（不带 force）", async () => {
    mockStatus();
    const discard = vi.spyOn(api, "scmDiscard").mockResolvedValue({ discarded: ["README.md"] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "放弃 README.md 的更改" }));
    expect(screen.getByText("确认放弃更改？")).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(discard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "放弃 README.md 的更改" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("s1", ["README.md"], false));
  });

  it("删除未跟踪文件需先确认，确认后调 discard 且 force=true", async () => {
    mockStatus();
    const discard = vi.spyOn(api, "scmDiscard").mockResolvedValue({ discarded: ["notes.txt"] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "删除未跟踪文件 notes.txt" }));
    expect(screen.getByText("确认删除该未跟踪文件？")).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("s1", ["notes.txt"], true));
  });

  it("点击未跟踪条目改走文件内容预览（不调 diff），头部标注未跟踪", async () => {
    mockStatus();
    const readFile = vi.spyOn(api, "readFile").mockResolvedValue({ content: "hello notes", encoding: "utf8", truncated: false, revision: "r1" });
    const scmDiff = vi.spyOn(api, "scmDiff");
    renderPanel();

    fireEvent.click(await screen.findByText("notes.txt"));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "notes.txt"));
    expect(await screen.findByLabelText("预览未跟踪文件 notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/（未跟踪）/)).toBeInTheDocument();
    // CodeBlock 高亮就绪前渲染纯文本；高亮注入后可能拆成多个 token span，按 textContent 匹配
    await waitFor(() => {
      expect(document.querySelector(".code-block")?.textContent).toContain("hello notes");
    });
    expect(scmDiff).not.toHaveBeenCalled();
  });

  it("历史折叠区：展开后拉取 git log，一行式展示 shortHash/subject/author/relTime", async () => {
    mockStatus();
    const scmLog = vi.spyOn(api, "scmLog").mockResolvedValue({
      commits: [{ hash: "abcdef1234567890", shortHash: "abcdef1", author: "Alice", relTime: "2 天前", subject: "feat: add panel" }],
    });
    renderPanel();

    expect(scmLog).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));
    await waitFor(() => expect(scmLog).toHaveBeenCalledWith("s1", 50));
    expect(await screen.findByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("feat: add panel")).toBeInTheDocument();
    expect(screen.getByText("Alice · 2 天前")).toBeInTheDocument();
  });

  it("历史折叠区：空仓库显示空态文案", async () => {
    mockStatus();
    vi.spyOn(api, "scmLog").mockResolvedValue({ commits: [] });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));
    expect(await screen.findByText("暂无提交记录。")).toBeInTheDocument();
  });

  it("合回 worktree 成功：提示并刷新 worktrees/status", async () => {
    mockStatus();
    const worktreesSpy = vi.spyOn(api, "scmWorktrees").mockResolvedValue(worktrees);
    const merge = vi.spyOn(api, "scmMergeWorktree").mockResolvedValue({ merged: true, conflicts: [], strategy: "merge", branch: "main" });
    const { onNotice } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "合回 worktree wt-feature" }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith("s1", "wt-feature"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("合回")));
    await waitFor(() => expect(worktreesSpy.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("合回 worktree 冲突：展开展示结构化冲突文件列表", async () => {
    mockStatus();
    vi.spyOn(api, "scmWorktrees").mockResolvedValue(worktrees);
    vi.spyOn(api, "scmMergeWorktree").mockResolvedValue({ merged: false, conflicts: ["src/a.ts", "src/b.ts"], strategy: "merge", branch: "main" });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "合回 worktree wt-feature" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getByText(/冲突文件（2）/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭冲突列表" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
