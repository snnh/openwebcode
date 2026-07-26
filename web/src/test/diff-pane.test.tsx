/**
 * DiffPane 单测（0.5.0 Phase 1b 验收）：
 * - 三种来源（SCM / 检查点 / agent 工具改动）同一组件打开；
 * - hunk 接受=保留（仅标记）、拒绝=内容写回走 api.writeFile（server 权限链入口，mock 断言参数）；
 * - plan 模式只读（无写按钮）；Monaco 加载失败降级文本 diff 且 hunk 操作仍可用；
 * - 检查点摘要后端降级；agent write_file 只读；Esc 回对话。
 * Monaco 本体用 fake（helpers/fake-monaco.ts），api 层 mock。
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { DiffPane, type DiffSpec } from "../components/editor/DiffPane";
import { createFakeMonaco } from "./helpers/fake-monaco";
import type { MonacoApi } from "../components/editor/monaco-loader";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      scmDiff: vi.fn(),
      checkpointDiff: vi.fn(),
    },
  };
});

const loadMonacoMock = vi.fn<() => Promise<MonacoApi>>();
vi.mock("../components/editor/monaco-loader", () => ({
  loadMonaco: () => loadMonacoMock(),
}));

const readFile = vi.mocked(api.readFile);
const writeFile = vi.mocked(api.writeFile);
const scmDiff = vi.mocked(api.scmDiff);
const checkpointDiff = vi.mocked(api.checkpointDiff);

const CURRENT = "line1\nline2 changed\nline3\n";
const ORIGINAL = "line1\nline2\nline3\n";
const REVISION = "a".repeat(64);
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

function renderPane(spec: DiffSpec, props: Partial<Parameters<typeof DiffPane>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const onNotice = vi.fn();
  const actionsRef: { current: { accept?(): void; reject?(): void; focus?(): void } } = { current: {} };
  const view = render(
    <QueryClientProvider client={client}>
      <DiffPane
        sessionId="s1"
        spec={spec}
        dark
        actionsRef={actionsRef}
        onClose={onClose}
        onNotice={onNotice}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { view, onClose, onNotice, actionsRef };
}

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue({ content: CURRENT, encoding: "utf-8", truncated: false, revision: REVISION });
  writeFile.mockResolvedValue({ ok: true, revision: "b".repeat(64) });
  scmDiff.mockResolvedValue({ isRepo: true, stat: " src/a.ts | 2 +-", diff: SCM_DIFF_TEXT, totalBytes: SCM_DIFF_TEXT.length, truncated: false });
  checkpointDiff.mockResolvedValue({ diff: ` src/a.ts | 2 +-\n\n${SCM_DIFF_TEXT}` });
});

describe("DiffPane：SCM 来源", () => {
  const spec: DiffSpec = { source: "scm", path: "src/a.ts", staged: false };

  it("Monaco DiffEditor 渲染（original=反推的 HEAD 内容）；hunk 接受=保留仅标记", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane(spec);
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    expect(fake.diffEditors[0].model?.original.value).toBe(ORIGINAL);
    expect(fake.diffEditors[0].model?.modified.value).toBe(CURRENT);
    // 接受：不写文件，只标记状态
    fireEvent.click(await view.findByRole("button", { name: "接受" }));
    expect(writeFile).not.toHaveBeenCalled();
    expect(await view.findByText("已接受")).toBeInTheDocument();
    expect(await view.findByText(/全部 hunk 已处理/)).toBeInTheDocument();
  });

  it("拒绝 hunk：内容写回走 api.writeFile（server 权限链），成功后标记并更新新侧", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view, onNotice } = renderPane(spec);
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
    expect(await view.findByText("已拒绝")).toBeInTheDocument();
    await waitFor(() => expect(onNotice.mock.calls.some(([message]) => String(message).includes("写回"))).toBe(true));
  });

  it("写回被 server 拒绝（plan/权限 403）：hunk 保持待处理并提示错误", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    writeFile.mockRejectedValue(new Error("Plan 模式为只读：write_file 被拦截"));
    const { view, onNotice } = renderPane(spec);
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Plan 模式为只读"), "error"));
    expect(view.getByText("待处理")).toBeInTheDocument();
  });

  it("已暂存改动：只读并如实提示（内容写回无法触及索引）", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane({ source: "scm", path: "src/a.ts", staged: true });
    expect(await view.findByText(/已暂存的改动位于 git 索引中/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
    expect(view.getByTestId("diff-fallback")).toBeInTheDocument();
  });

  it("plan 模式：隐藏 hunk 写按钮并提示只读", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane(spec, { readOnly: true });
    expect(await view.findByText(/Plan 模式为只读/)).toBeInTheDocument();
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
    expect(view.queryByRole("button", { name: "接受" })).toBeNull();
  });

  it("命令动作面：accept/reject 作用于首个待处理 hunk", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view, actionsRef } = renderPane(spec);
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    act(() => actionsRef.current.reject?.());
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
    expect(await view.findByText("已拒绝")).toBeInTheDocument();
  });
});

describe("DiffPane：检查点来源", () => {
  const spec: DiffSpec = { source: "checkpoint", checkpointId: "a".repeat(40), label: "cp" };

  it("unified diff 可解析：hunk 拒绝=恢复到此 hunk（写回旧侧内容）", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane(spec);
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    expect(fake.diffEditors[0].model?.original.value).toBe(ORIGINAL);
    fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
  });

  it("后端只给摘要（非 unified diff）：摘要模式展示原文，无 hunk 操作", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    checkpointDiff.mockResolvedValue({ diff: "M\t/ws/a.txt" });
    const { view } = renderPane(spec);
    expect(await view.findByText(/只提供差异摘要/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
  });
});

describe("DiffPane：agent 工具改动来源", () => {
  it("edit_file：拒绝=写回改动前内容（oldText 还原）", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane({ source: "agent-edit", path: "src/a.ts", oldText: "line2", newText: "line2 changed" });
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    expect(fake.diffEditors[0].model?.original.value).toBe(ORIGINAL);
    fireEvent.click(await view.findByRole("button", { name: "拒绝改动" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
    expect(await view.findByText(/已拒绝并还原该工具改动/)).toBeInTheDocument();
  });

  it("edit_file：改动已不在当前文件中 → 提示且不提供写操作", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    readFile.mockResolvedValue({ content: "unrelated\n", encoding: "utf-8", truncated: false, revision: REVISION });
    const { view } = renderPane({ source: "agent-edit", path: "src/a.ts", oldText: "line2", newText: "line2 changed" });
    expect(await view.findByText(/已找不到该工具改动/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "拒绝改动" })).toBeNull();
  });

  it("write_file：无改动前内容，只读展示写入结果", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane({ source: "agent-write", path: "src/a.ts", content: "written\n" });
    expect(await view.findByText(/不保留改动前内容/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
    await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
    expect(fake.diffEditors[0].model?.modified.value).toBe("written\n");
  });
});

describe("DiffPane：降级与关闭", () => {
  const spec: DiffSpec = { source: "scm", path: "src/a.ts", staged: false };

  it("Monaco 加载失败：降级文本视图，hunk 拒绝仍走写回", async () => {
    loadMonacoMock.mockRejectedValue(new Error("chunk load failed"));
    const { view } = renderPane(spec);
    fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
    expect(await view.findByTestId("diff-fallback-content")).toBeInTheDocument();
  });

  it("Esc（Monaco 外焦点）→ onClose 回对话", async () => {
    loadMonacoMock.mockRejectedValue(new Error("chunk load failed"));
    const { view, onClose } = renderPane(spec);
    await view.findByRole("button", { name: "拒绝" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("移动端 summaryOnly：只读摘要，不加载 Monaco、无写按钮", async () => {
    const { view } = renderPane(spec, { summaryOnly: true });
    expect(await view.findByText(/1 个 hunk/)).toBeInTheDocument();
    expect(loadMonacoMock).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
  });
});
