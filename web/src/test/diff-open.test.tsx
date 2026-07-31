/**
 * 统一 diff 视图入口与布局回归（0.5.0 Phase 1b 验收，App 级）：
 * - 三种来源打开路径：Run 轨道工具卡（agent 工具改动）、SCM 面板、时间线检查点；
 * - 对话为主约束：默认无 diff、切换会话即关闭、Esc 回对话且焦点回 Composer、移动端降级只读摘要（不加载 Monaco）。
 * Monaco 本体用 fake；isMobile 经 use-media-query mock 控制。
 */
import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMonaco } from "./helpers/fake-monaco";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";
import type { MonacoApi } from "../components/editor/monaco-loader";

let mobileMatches = false;
vi.mock("../hooks/use-media-query", () => ({
  MOBILE_BREAKPOINT: "(max-width: 1024px)",
  useMediaQuery: () => mobileMatches,
}));

const fake = createFakeMonaco();
const loadMonacoMock = vi.fn<() => Promise<MonacoApi>>(() => Promise.resolve(fake.monaco));
vi.mock("../components/editor/monaco-loader", () => ({
  loadMonaco: () => loadMonacoMock(),
}));

const CURRENT = "line1\nline2 changed\nline3\n";
const SCM_DIFF_TEXT = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-line2",
  "+line2 changed",
  " line3",
].join("\n");
const CP_ID = "a".repeat(40);

const WRITE_MSG = {
  id: "m1", role: "assistant", createdAt: "2026-07-24T00:00:00.000Z",
  content: [{ type: "tool_call", name: "write_file", input: { path: "src/a.ts", content: "written\n" } }],
};

const S1 = {
  id: "s1", cwd: "/workspace/project", provider: "anthropic", model: "claude-opus-4-8",
  thinking: "adaptive", effort: "high", permissionMode: "ask", title: "会话一",
  createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
  sandbox: { enabled: false, readRoots: [], writeRoots: [], denyPaths: [], network: "deny" },
  messages: [WRITE_MSG],
};
const S2 = { ...S1, id: "s2", title: "会话二", messages: [] };

function installFetchMock(): void {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([S1, S2].map(({ messages: _m, sandbox: _s, ...meta }) => meta));
    if (url.includes("/context")) return json({ ledger: { usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 }, entries: [] }, preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" } });
    if (url.includes("/api/workspaces/")) return json({ error: "Symbol index is not enabled" }, 501);
    if (url.includes("/git/status")) return json({ isRepo: true, branch: "main", staged: [], unstaged: [{ path: "src/a.ts", code: " M" }], untracked: [], totals: { staged: 0, unstaged: 1, untracked: 0 }, truncated: false });
    if (url.includes("/git/diff")) return json({ isRepo: true, stat: " src/a.ts | 2 +-", diff: SCM_DIFF_TEXT, totalBytes: SCM_DIFF_TEXT.length, truncated: false });
    if (url.includes("/git/worktrees")) return json({ worktrees: [] });
    if (url.includes(`/checkpoints/${CP_ID}/diff`)) return json({ diff: ` src/a.ts | 2 +-\n\n${SCM_DIFF_TEXT}` });
    if (url.includes("/checkpoints")) return json([{ id: CP_ID, label: "cp1", createdAt: "2026-07-24T00:00:00.000Z", messageCount: 1 }]);
    if (url.includes("/snapshot-capability")) return json({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
    if (url.includes("/timeline")) return json({ entries: [], activeLeafId: undefined });
    if (url.includes("/files/content")) {
      if (init?.method === "PUT") return json({ ok: true, revision: "b".repeat(64) });
      return json({ content: CURRENT, encoding: "utf-8", truncated: false, revision: "a".repeat(64) });
    }
    if (url.match(/\/api\/sessions\/(s1|s2)\//)) return json([]);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(S1);
    if (url.match(/\/api\/sessions\/s2(\?.*)?$/)) return json(S2);
    if (url.endsWith("/api/models")) return json([]);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/extensions")) return json([]);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

describe("统一 diff 视图：入口与布局回归", () => {
  setupStubWebSocket();
  beforeEach(() => {
    mobileMatches = false;
    window.localStorage.clear();
    loadMonacoMock.mockClear();
    fake.diffEditors.length = 0;
    installFetchMock();
  });

  it("工具卡一键打开 diff（agent 来源）；切换会话即关闭回到纯对话", async () => {
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    // 默认纯对话：无 diff 视图
    expect(view.container.querySelector(".diff-pane")).toBeNull();
    // 工具行默认折叠：先展开，diff 入口在展开区内
    fireEvent.click(view.getByRole("button", { name: /write_file/ }));
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开该文件变化" }));
    // diff 分栏打开（agent-write 只读展示写入结果），Monaco 懒加载被触发
    await waitFor(() => expect(view.container.querySelector(".diff-pane")).not.toBeNull());
    expect(loadMonacoMock).toHaveBeenCalledTimes(1);
    // 切换会话 → diff 关闭
    fireEvent.click((await view.findAllByText("会话二"))[0]);
    await waitFor(() => expect(view.container.querySelector(".diff-pane")).toBeNull());
  });

  it("Esc 关闭 diff 回对话，焦点回 Composer", async () => {
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    // 工具行默认折叠：先展开，diff 入口在展开区内
    fireEvent.click(view.getByRole("button", { name: /write_file/ }));
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开该文件变化" }));
    await waitFor(() => expect(view.container.querySelector(".diff-pane")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(view.container.querySelector(".diff-pane")).toBeNull());
    expect(document.activeElement?.id).toBe("composer-input");
  });

  it("SCM 面板文件 diff 一键在 diff 视图打开（hunk 接受/拒绝可用）", async () => {
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    fireEvent.click(view.getByRole("button", { name: "源代码管理" }));
    // 会话里 write_file 工具行摘要同样含 src/a.ts：等 SCM 文件行出现并精确点击它
    await waitFor(() => expect(view.container.querySelector(".problems-item")).not.toBeNull());
    fireEvent.click(view.container.querySelector(".problems-item")!);
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开（支持 hunk 接受/拒绝）" }));
    // SCM 来源：hunk 操作条出现
    await view.findByRole("list", { name: "hunk 列表" });
    expect(view.getByRole("button", { name: "接受" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
  });

  it("时间线检查点对比一键在 diff 视图打开", async () => {
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    fireEvent.click(view.getByRole("button", { name: "时间线" }));
    fireEvent.click(await view.findByRole("button", { name: "cp1" }));
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开（支持 hunk 级恢复）" }));
    await view.findByRole("list", { name: "hunk 列表" });
  });

  it("快捷键：mod+alt+r 拒绝当前 hunk（keybindings 注册表分发）", async () => {
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    fireEvent.click(view.getByRole("button", { name: "源代码管理" }));
    // 会话里 write_file 工具行摘要同样含 src/a.ts：等 SCM 文件行出现并精确点击它
    await waitFor(() => expect(view.container.querySelector(".problems-item")).not.toBeNull());
    fireEvent.click(view.container.querySelector(".problems-item")!);
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开（支持 hunk 接受/拒绝）" }));
    await view.findByRole("list", { name: "hunk 列表" });
    fireEvent.keyDown(window, { key: "r", ctrlKey: true, altKey: true });
    expect(await view.findByText("已拒绝")).toBeInTheDocument();
  });

  it("移动端：工具卡打开 diff 降级为只读摘要浮层，不加载 Monaco", async () => {
    mobileMatches = true;
    const view = renderApp();
    await view.findByRole("heading", { name: "会话一" });
    // 工具行默认折叠：先展开，diff 入口在展开区内
    fireEvent.click(view.getByRole("button", { name: /write_file/ }));
    fireEvent.click(await view.findByRole("button", { name: "在 diff 视图中打开该文件变化" }));
    await view.findByRole("dialog", { name: "变更摘要" });
    expect(view.container.querySelector(".editor-pane.diff-pane")).toBeNull();
    expect(loadMonacoMock).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
  });
});
