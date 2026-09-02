import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../lib/api";
import type { Checkpoint, DiagnosticSet, FileEntry, SandboxMode, ScmDiff, ScmStatus, ScmWorktree, SessionDetail, SessionTimeline, SnapshotCapabilityInfo } from "../lib/contracts";
import { auxViewsStore } from "../workbench/aux-views";
import { uiStore } from "../app/ui-store";
import { FilesView } from "../workbench/sidebar/FilesView";
import { ProblemsView } from "../workbench/sidebar/ProblemsView";
import { SandboxPanel } from "../panels/SandboxPanel";
import { ScmView } from "../workbench/sidebar/ScmView";
import { TimelinePanel } from "../panels/TimelinePanel";
import { makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const entry = (name: string, type: FileEntry["type"], size = 10): FileEntry => ({ name, type, size });

function renderFilesView(sessionId?: string) {
  return renderWithClient(<FilesView sessionId={sessionId} />);
}

describe("FilesView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderFilesView(undefined);
    expect(screen.getByText("选择会话以浏览工作区文件。")).toBeInTheDocument();
  });

  it("目录树：目录优先排序，展开目录加载子级", async () => {
    vi.spyOn(api, "listFiles").mockImplementation((_id, path = ".") => Promise.resolve({
      entries: path === "."
        ? [entry("zeta.txt", "file"), entry("docs", "directory"), entry("alpha.ts", "file", 2048)]
        : [entry("readme.md", "file", 12)],
      truncated: false,
    }));
    renderFilesView("s1");

    const rows = await screen.findAllByRole("button", { name: /zeta\.txt|docs|alpha\.ts/ });
    expect(rows[0]).toHaveTextContent("docs");
    expect(rows[1]).toHaveTextContent("alpha.ts");
    expect(rows[2]).toHaveTextContent("zeta.txt");

    fireEvent.click(screen.getByRole("button", { name: /docs/ }));
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });

  it("目录读取失败显示行内错误（role=alert）", async () => {
    vi.spyOn(api, "listFiles").mockRejectedValue(new ApiError(500, "磁盘错误"));
    renderFilesView("s1");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取目录：磁盘错误");
  });

  it("空目录显示占位提示", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [], truncated: false });
    renderFilesView("s1");
    expect(await screen.findByText("（空目录）")).toBeInTheDocument();
  });

  it("文本预览与关闭；「在编辑器中打开」写 auxViews", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("main.ts", "file")], truncated: false });
    vi.spyOn(api, "readFile").mockResolvedValue({ content: "const a = 1;", encoding: "utf-8", truncated: false, revision: "r1" });
    const view = renderFilesView("s1");

    fireEvent.click(await view.findByText("main.ts"));
    expect(await view.findByText("const a = 1;")).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "在编辑器中打开 main.ts" }));
    expect(auxViewsStore.get().editor).toEqual({ path: "main.ts" });
    view.unmount();

    // 关闭预览按钮收起预览区
    vi.spyOn(api, "readFile").mockResolvedValue({ content: "x", encoding: "utf-8", truncated: false, revision: "r1" });
    const close = renderFilesView("s1");
    fireEvent.click(await close.findByText("main.ts"));
    fireEvent.click(await close.findByRole("button", { name: "关闭预览" }));
    expect(close.queryByRole("button", { name: "关闭预览" })).toBeNull();
  });

  it("文本预览读取失败显示错误；非 UTF-8 给出二进制提示", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("bin.dat", "file")], truncated: false });
    vi.spyOn(api, "readFile").mockRejectedValue(new ApiError(422, "not UTF-8 text"));
    renderFilesView("s1");
    fireEvent.click(await screen.findByText("bin.dat"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("该文件非 UTF-8 文本（可能为二进制），无法预览。");
  });

  it("图片文件走 fileRawUrl 预览，不拉文本内容", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("icon.png", "file")], truncated: false });
    const readFile = vi.spyOn(api, "readFile");
    renderFilesView("s1");
    fireEvent.click(await screen.findByText("icon.png"));
    const img = await screen.findByRole("img", { name: "icon.png" });
    expect(img).toHaveAttribute("src", api.fileRawUrl("s1", "icon.png"));
    expect(readFile).not.toHaveBeenCalled();
  });

  it("截断的长文件显示「加载更多」并追加内容", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("big.log", "file")], truncated: false });
    const readFile = vi.spyOn(api, "readFile")
      .mockResolvedValueOnce({ content: "first\n", encoding: "utf-8", truncated: true, revision: "r1" })
      .mockResolvedValueOnce({ content: "second\n", encoding: "utf-8", truncated: false, revision: "r1" });
    renderFilesView("s1");

    fireEvent.click(await screen.findByText("big.log"));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "big.log", { offset: 1, limit: 2000 }));
    expect(await screen.findByText(/second/)).toBeInTheDocument();
  });
});

const diagnostics: DiagnosticSet = {
  tool: "vitest",
  summary: { passed: 8, failed: 3, skipped: 1, durationMs: 1534 },
  failures: [
    { name: "renders header", file: "src/app.test.ts", line: 12, column: 5, message: "expected true to be false" },
    { name: "parses output", file: "src/parser.test.ts", line: 40, message: "timeout of 2000ms exceeded" },
    { name: "lint style", file: "src/parser.test.ts", message: "warning: prefer const" },
    { name: "suite setup", message: "failed to start worker" },
  ],
};

function renderProblemsView(sessionId?: string) {
  return renderWithClient(<ProblemsView sessionId={sessionId} />);
}

describe("ProblemsView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderProblemsView(undefined);
    expect(screen.getByText("选择会话以查看诊断问题。")).toBeInTheDocument();
  });

  it("按文件分组展示 failures，标注来源工具与汇总", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderProblemsView("s1");

    expect(await screen.findByText("src/app.test.ts")).toBeInTheDocument();
    expect(screen.getByText("src/parser.test.ts")).toBeInTheDocument();
    expect(screen.getByText("（未定位到文件）")).toBeInTheDocument();
    expect(screen.getByText("vitest")).toBeInTheDocument();
    expect(screen.getByText(/通过 8 · 失败 3 · 跳过 1/)).toBeInTheDocument();
    expect(screen.getByText(":12:5")).toBeInTheDocument();
    // 每个文件组的失败计数
    expect(screen.getByText("src/parser.test.ts").parentElement?.textContent).toContain("2");
  });

  it("诊断加载失败：404 按空态、其余行内错误", async () => {
    // 404（无诊断记录）按空态处理
    vi.spyOn(api, "latestDiagnostics").mockRejectedValue(new ApiError(404, "not found"));
    const notFound = renderProblemsView("s1");
    expect(await notFound.findByText(/暂无问题/)).toBeInTheDocument();
    notFound.unmount();

    // 非 404 错误显示行内错误（role=alert）
    vi.spyOn(api, "latestDiagnostics").mockRejectedValue(new ApiError(500, "服务异常"));
    const failed = renderProblemsView("s1");
    const alert = await failed.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取诊断结果：服务异常");
  });

  it("严重度过滤：错误/警告/全部三档", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderProblemsView("s1");

    fireEvent.click(await screen.findByRole("button", { name: /^错误 3$/ }));
    expect(screen.getByText("renders header")).toBeInTheDocument();
    expect(screen.queryByText("lint style")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^警告 1$/ }));
    expect(screen.getByText("lint style")).toBeInTheDocument();
    expect(screen.queryByText("renders header")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^全部 4$/ }));
    expect(screen.getByText("renders header")).toBeInTheDocument();
    expect(screen.getByText("lint style")).toBeInTheDocument();
  });

  it("点击条目在编辑器分栏打开行列；未定位文件条目禁用", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    const first = renderProblemsView("s1");

    fireEvent.click(await first.findByText("renders header"));
    expect(auxViewsStore.get().editor).toEqual({ path: "src/app.test.ts", line: 12, column: 5 });

    fireEvent.click(first.getByText("parses output"));
    expect(auxViewsStore.get().editor).toEqual({ path: "src/parser.test.ts", line: 40 });
    first.unmount();
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });

    // 未定位到文件的条目不可点击
    const second = renderProblemsView("s1");
    const item = (await second.findByText("suite setup")).closest("button")!;
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(auxViewsStore.get().editor).toBeUndefined();
  });
});

const sandboxSession = makeSession({
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "沙盒面板测试",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
});

function renderSandboxPanel(detail: SessionDetail = sandboxSession): void {
  vi.spyOn(api, "session").mockResolvedValue(detail);
  renderWithClient(<SandboxPanel sessionId={detail.id} />);
}

describe("SandboxPanel 平台适配", () => {
  it.each<{ label: string; sandboxMode?: SandboxMode; expected: string; linuxCaps?: boolean; absent?: RegExp }>([
    { label: "win32 默认（未设置）", expected: "应用容器（AppContainer）" },
    { label: "linux 存量 jobobject", sandboxMode: "jobobject", expected: "强制模式（Landlock）", linuxCaps: true, absent: /Job Object/ },
    { label: "linux 未设置", expected: "隔离模式（bubblewrap）", linuxCaps: true },
    { label: "linux bubblewrap", sandboxMode: "bubblewrap", expected: "隔离模式（bubblewrap）", linuxCaps: true },
  ])("平台能力→模式文案映射（$label）", async ({ sandboxMode, expected, linuxCaps, absent }) => {
    if (linuxCaps) {
      vi.mocked(api.sandboxCapabilities).mockResolvedValue({ platform: "linux", appcontainer: false, jobobject: true, off: true, wsb: { available: false, reason: "仅 Windows" }, bindLink: { available: false, reason: "仅 Windows" }, bwrap: { available: true } });
    }
    renderSandboxPanel({ ...sandboxSession, ...(sandboxMode ? { sandboxMode } : {}) });
    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    if (absent) expect(screen.queryByText(absent)).not.toBeInTheDocument();
  });
});

describe("SandboxPanel 执行级别", () => {
  it.each<{ label: string; status: Record<string, string>; pill?: string; pillClass?: string; reason?: string; noRecord?: boolean }>([
    { label: "enforced", status: { sandboxCapability: "enforced", sandboxReason: "Job Object 已应用" }, pill: "已强制", pillClass: "ok", reason: "Job Object 已应用" },
    { label: "partial", status: { sandboxCapability: "partial" }, pill: "部分生效", pillClass: "amber" },
    { label: "advisory", status: { sandboxCapability: "advisory", sandboxReason: "核心不支持" }, pill: "仅提示", pillClass: "danger", reason: "核心不支持" },
    { label: "无记录", status: {}, noRecord: true },
  ])("执行级别 $label 徽标渲染", async ({ status, pill, pillClass, reason, noRecord }) => {
    vi.mocked(api.sessionSandboxStatus).mockResolvedValue(status as never);
    renderSandboxPanel();

    if (noRecord) {
      // 无记录时显示 —
      await waitFor(() => expect(api.sessionSandboxStatus).toHaveBeenCalledWith("session-1"));
      expect(screen.getByText("执行级别").nextElementSibling?.textContent).toBe("—");
    } else {
      const el = await screen.findByText(pill!);
      expect(el).toHaveClass("pill", pillClass!);
      if (reason) expect(screen.getByText(reason)).toBeInTheDocument();
    }
  });
});

describe("SandboxPanel 网络策略", () => {
  it("filtered：显示代理过滤文案", async () => {
    renderSandboxPanel({ ...sandboxSession, sandbox: { ...sandboxSession.sandbox!, network: "filtered" } });
    await waitFor(() => expect(screen.getByText("代理过滤（仅 Windows）")).toBeInTheDocument());
  });
});

describe("SandboxPanel 空态", () => {
  it("空态：无会话引导；无沙盒配置提示", async () => {
    renderWithClient(<SandboxPanel />);
    expect(screen.getByText("选择会话以查看沙盒策略。")).toBeInTheDocument();

    // 会话无沙盒配置
    renderSandboxPanel({ ...sandboxSession, sandbox: undefined });
    expect(await screen.findByText("未配置沙盒策略。")).toBeInTheDocument();
  });
});

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

const scmDiff: ScmDiff = {
  isRepo: true,
  stat: " src/dirty.ts | 2 +-",
  diff: "diff --git a/src/dirty.ts b/src/dirty.ts\n-old\n+new",
  totalBytes: 50,
  truncated: false,
};

function renderScmView(sessionId?: string) {
  return renderWithClient(<ScmView sessionId={sessionId} />);
}

describe("ScmView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
    uiStore.set({ notice: undefined, notifications: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderScmView(undefined);
    expect(screen.getByText("选择会话以查看源代码管理。")).toBeInTheDocument();
  });

  it("状态读取失败显示行内错误（role=alert）", async () => {
    vi.spyOn(api, "scmStatus").mockRejectedValue(new ApiError(500, "boom"));
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderScmView("s1");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取 git 状态（该会话目录可能不是 git 仓库）：boom");
  });

  it("非 git 仓库显示空态", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue({ ...cleanStatus, isRepo: false, branch: undefined });
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderScmView("s1");
    expect(await screen.findByText("该会话目录不是 git 仓库。")).toBeInTheDocument();
  });

  it("干净工作区显示分支与「没有变更」", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    renderScmView("s1");
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("工作区干净，没有变更。")).toBeInTheDocument();
  });

  it("分组渲染 staged/unstaged/untracked，行内 stage 调用接口", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    vi.spyOn(api, "scmDiff").mockResolvedValue(scmDiff);
    const stage = vi.spyOn(api, "scmStage").mockResolvedValue({ ok: true });
    renderScmView("s1");

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
    const discard = vi.spyOn(api, "scmDiscard").mockResolvedValue({ ok: true });
    renderScmView("s1");

    fireEvent.click(await screen.findByRole("button", { name: "放弃 src/dirty.ts 的更改" }));
    expect(screen.getByText("确认放弃更改？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("s1", ["src/dirty.ts"], false));
  });

  it("点击变更项：diff/未跟踪文件内容预览并支持写入 auxViews", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    vi.spyOn(api, "scmDiff").mockResolvedValue(scmDiff);
    const first = renderScmView("s1");

    // 已跟踪变更：只读 diff + 「在 diff 视图中打开」写入 auxViews
    fireEvent.click(await screen.findByText("src/dirty.ts"));
    expect(await screen.findByText("-old")).toBeInTheDocument();
    expect(screen.getByText("+new")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "在 diff 视图中打开（支持 hunk 接受/拒绝）" }));
    expect(auxViewsStore.get().diff).toEqual({ source: "scm", path: "src/dirty.ts", staged: false });
    first.unmount();

    // 未跟踪文件点击后读取文件内容预览
    const readFile = vi.spyOn(api, "readFile").mockResolvedValue({ content: "草稿内容", encoding: "utf-8", truncated: false, revision: "r1" });
    renderScmView("s1");
    fireEvent.click(await screen.findByText("notes.txt"));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "notes.txt"));
    expect(await screen.findByText("草稿内容")).toBeInTheDocument();
  });

  it("提交辅助：下发 agent 消息并提示", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(dirtyStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendMessage").mockResolvedValue({ accepted: true });
    renderScmView("s1");

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
    renderScmView("s1");

    expect(log).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));
    expect(await screen.findByText("初始提交")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
  });

  it("worktree：创建/清理/合回成功提示与冲突文件列表", async () => {
    vi.spyOn(api, "scmStatus").mockResolvedValue(cleanStatus);
    vi.spyOn(api, "scmWorktrees").mockResolvedValue([worktree]);
    const create = vi.spyOn(api, "scmCreateWorktree").mockResolvedValue(worktree);
    const remove = vi.spyOn(api, "scmDeleteWorktree").mockResolvedValue({ removed: true, name: "wt-1" });
    const merge = vi.spyOn(api, "scmMergeWorktree").mockResolvedValue({ merged: true, conflicts: [], strategy: "merge", branch: "main" });
    const first = renderScmView("s1");

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
    first.unmount();

    // 合回冲突：展示冲突文件列表
    vi.mocked(api.scmMergeWorktree).mockResolvedValue({ merged: false, conflicts: ["src/a.ts"], strategy: "merge", branch: "main" });
    renderScmView("s1");
    fireEvent.click(await screen.findByRole("button", { name: "合回 worktree wt-1" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("合回 wt-1 的冲突文件（1）");
    expect(alert).toHaveTextContent("src/a.ts");
  });
});

const checkpoints: Checkpoint[] = [
  { id: "cp-1", label: "初始快照", createdAt: "2026-07-30T00:00:00.000Z", messageCount: 4 },
];

const timeline: SessionTimeline = {
  activeLeafId: "m-2",
  entries: [
    { id: "m-1", role: "user", createdAt: "2026-07-30T00:00:00.000Z" },
    { id: "m-2", role: "assistant", createdAt: "2026-07-30T00:00:01.000Z", runId: "run-1" },
  ],
};

const capability: SnapshotCapabilityInfo = { backend: "git-shadow", costHint: "instant", requiresAdmin: false };

beforeEach(() => {
  vi.spyOn(api, "sandboxCapabilities").mockResolvedValue({ platform: "win32", appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试" }, bindLink: { available: false, reason: "测试" } });
  // 默认无执行级别记录（{}）
  vi.spyOn(api, "sessionSandboxStatus").mockResolvedValue({});
  auxViewsStore.set({ diff: undefined });
  uiStore.set({ sessionId: "s-1" });
  vi.spyOn(api, "checkpoints").mockResolvedValue(checkpoints);
  vi.spyOn(api, "timeline").mockResolvedValue(timeline);
  vi.spyOn(api, "snapshotCapability").mockResolvedValue(capability);
});

afterEach(() => {
  auxViewsStore.set({ diff: undefined });
  vi.restoreAllMocks();
});

describe("TimelinePanel", () => {
  it("Timeline 空态：无会话引导与无检查点提示", async () => {
    renderWithClient(<TimelinePanel running={false} />);
    expect(screen.getByText("选择会话以查看检查点。")).toBeInTheDocument();

    // 无检查点（有会话）
    vi.mocked(api.checkpoints).mockResolvedValue([]);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    expect(await screen.findByText("暂无检查点。")).toBeInTheDocument();
  });

  it("展示会话树、后端徽标与检查点列表；当前叶节点标记且不可检出", async () => {
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    expect(await screen.findByText(/会话树 · 2 个节点/)).toBeInTheDocument();
    expect(screen.getByText("当前")).toBeInTheDocument();
    expect(screen.getByText(/git-shadow · 即时 CoW/)).toBeInTheDocument();
    expect(screen.getByText("初始快照")).toBeInTheDocument();
    // 当前叶节点的「继续」按钮禁用
    const current = document.querySelector(".timeline-node.active")!;
    expect(current.querySelector<HTMLButtonElement>(".copy-btn")!.disabled).toBe(true);
  });

  it("「继续」检出到该节点，「分叉」创建新会话并切换", async () => {
    const checkout = vi.spyOn(api, "checkoutSession").mockResolvedValue({} as never);
    const fork = vi.spyOn(api, "forkSession").mockResolvedValue({ sessionId: "s-2" } as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    await screen.findByText(/会话树 · 2 个节点/);
    const first = document.querySelectorAll(".timeline-node")[0]!;
    fireEvent.click(first.querySelectorAll("button")[0]!);
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("s-1", "m-1"));

    fireEvent.click(first.querySelectorAll("button")[1]!);
    await waitFor(() => expect(fork).toHaveBeenCalledWith("s-1", { messageId: "m-1" }));
    await waitFor(() => expect(uiStore.get().sessionId).toBe("s-2"));
  });

  it("「新建」创建检查点并刷新列表", async () => {
    const create = vi.spyOn(api, "createCheckpoint").mockResolvedValue({} as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /新建/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("s-1"));
  });

  it("运行中禁用新建/回滚操作", async () => {
    renderWithClient(<TimelinePanel sessionId="s-1" running={true} />);
    expect(await screen.findByRole("button", { name: /新建/ })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "完整回滚" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "仅文件" })).toBeDisabled();
  });

  it("展开检查点：内联 diff + 「在 diff 视图中打开」写入 auxViews", async () => {
    vi.spyOn(api, "checkpointDiff").mockResolvedValue({ diff: "diff --git a/x b/x" } as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    fireEvent.click(await screen.findByText("初始快照"));
    // CodeBlock 异步高亮会替换纯文本节点：waitFor 重试直到文本落在稳定节点上
    await waitFor(() => {
      expect(screen.getByText(/diff --git/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /在 diff 视图中打开/ }));
    expect(auxViewsStore.get().diff).toEqual({ source: "checkpoint", checkpointId: "cp-1", label: "初始快照" });
  });

  it("删除检查点需确认，确认后调用 deleteCheckpoint", async () => {
    const del = vi.spyOn(api, "deleteCheckpoint").mockResolvedValue({} as never);
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "删除该检查点" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("s-1", "cp-1"));
  });

  it("overlayfs 后端显示只读提示", async () => {
    vi.mocked(api.snapshotCapability).mockResolvedValue({ backend: "overlayfs", costHint: "instant", requiresAdmin: false });
    renderWithClient(<TimelinePanel sessionId="s-1" running={false} />);
    expect(await screen.findByText(/源目录只读/)).toBeInTheDocument();
  });
});
