import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { live } from "../app/live-store";
import { ui } from "../app/ui-store";
import { api } from "../lib/api";
import * as unifiedDiff from "../lib/unified-diff";
import { I18nProvider } from "../i18n";
import { EditorPane, monacoLanguageForPath, symbolAtLine } from "../components/editor/EditorPane";
import { DiffPane, type DiffSpec } from "../components/editor/DiffPane";
import { auxViews, auxViewsStore } from "../workbench/aux-views";
import { createFakeMonaco } from "./helpers/fake-monaco";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";
import type { MonacoApi } from "../components/editor/monaco-loader";

// api 层 mock 统一取并集：EditorPane/DiffPane 用例经此断言请求参数（readFile/writeFile/workspaceFileSymbols/scmDiff/checkpointDiff）；
// App 集成用例的其他 api 方法保留真实实现（fetch 层由 installAppFetchMock 打桩）
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      workspaceFileSymbols: vi.fn(),
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
const fileSymbols = vi.mocked(api.workspaceFileSymbols);
const scmDiff = vi.mocked(api.scmDiff);
const checkpointDiff = vi.mocked(api.checkpointDiff);

const REVISION = "a".repeat(64);
const FILE = { content: "export function foo() {\n  return 1;\n}\n", encoding: "utf-8", truncated: false, revision: REVISION };
const SYMBOLS = { symbols: [{ name: "foo", kind: "function", path: "src/a.ts", startLine: 1, endLine: 3, signature: "function foo()" }], indexStatus: "fresh" as const };

function renderPane(props: Partial<Parameters<typeof EditorPane>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  const onNotice = vi.fn();
  const actionsRef: { current: { save?(): void; focus?(): void } } = { current: {} };
  const view = render(
    <QueryClientProvider client={client}>
      <EditorPane
        sessionId="s1"
        path="src/a.ts"
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
  readFile.mockResolvedValue({ ...FILE });
  writeFile.mockResolvedValue({ ok: true, revision: "b".repeat(64) });
  fileSymbols.mockResolvedValue({ ...SYMBOLS });
});

/**
 * EditorPane 单测（0.5.0 Phase 1a 验收）：
 * Monaco 加载失败降级只读视图；保存走既有写路径（api.writeFile → server 权限链）；
 * plan 模式只读门禁；面包屑路径 + 光标符号。
 * Monaco 本体用 fake（见 helpers/fake-monaco.ts），api 层 mock 断言请求参数。
 */
describe("EditorPane：Monaco 加载失败降级", () => {
  it("loadMonaco 失败 → 降级为只读代码视图，提示原因，内容仍可见", async () => {
    loadMonacoMock.mockRejectedValue(new Error("chunk load failed"));
    const { view } = renderPane();
    expect(await view.findByText(/已降级为只读代码视图/)).toBeInTheDocument();
    // 只读代码视图渲染文件内容（不阻塞查看）
    expect(await view.findByText(/export function foo/)).toBeInTheDocument();
    expect(view.queryByTestId("monaco-host")).toBeNull();
  });
});

describe("EditorPane：保存走权限链", () => {
  it("修改后点保存 → api.writeFile（server 端权限/路径策略/plan 门禁入口），成功清脏并提示（按钮与 actionsRef.save 双触发）", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view, onNotice } = renderPane();
    await view.findByTestId("monaco-host");
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    const editor = fake.editors[0];
    // 初始无脏标记；修改后保存按钮可用
    expect(view.getByRole("button", { name: "保存" })).toBeDisabled();
    act(() => {
      editor.value = "export function foo() {\n  return 2;\n}\n";
      editor.__emitContent();
    });
    const saveButton = view.getByRole("button", { name: "保存" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", "export function foo() {\n  return 2;\n}\n", REVISION));
    await waitFor(() => expect(onNotice.mock.calls.some(([message]) => String(message).includes("已保存"))).toBe(true));
    await waitFor(() => expect(view.getByRole("button", { name: "保存" })).toBeDisabled());

    // App 命令动作面 actionsRef.save 触发同一保存路径
    const fake2 = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake2.monaco);
    const { view: view2, actionsRef } = renderPane();
    await within(view2.container).findByTestId("monaco-host");
    await waitFor(() => expect(fake2.editors).toHaveLength(1));
    act(() => {
      fake2.editors[0].value = "via-command";
      fake2.editors[0].__emitContent();
    });
    const writesBefore = writeFile.mock.calls.length;
    act(() => actionsRef.current.save?.());
    await waitFor(() => expect(writeFile.mock.calls.length).toBeGreaterThan(writesBefore));
    expect(writeFile).toHaveBeenLastCalledWith("s1", "src/a.ts", "via-command", REVISION);
  });

  it("保存失败 → 错误提示，脏标记保留", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    writeFile.mockRejectedValue(new Error("Plan 模式为只读：write_file 被拦截"));
    const { view, onNotice } = renderPane();
    await view.findByTestId("monaco-host");
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    act(() => {
      fake.editors[0].value = "changed";
      fake.editors[0].__emitContent();
    });
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Plan 模式为只读"), "error"));
    expect(view.getByRole("button", { name: "保存" })).toBeEnabled();
  });

});

describe("EditorPane：plan 模式与截断文件", () => {
  it("plan 模式：编辑器只读、无保存按钮、显示只读提示", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane({ readOnly: true });
    expect(await view.findByText(/Plan 模式为只读/)).toBeInTheDocument();
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    expect(fake.editors[0].options.readOnly).toBe(true);
    expect(view.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("文件被截断：禁用保存并提示", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    readFile.mockResolvedValue({ ...FILE, truncated: true });
    const { view } = renderPane();
    expect(await view.findByText(/保存已禁用/)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "保存" })).toBeNull();
  });
});

describe("EditorPane：面包屑", () => {
  it("路径段 + 光标处符号；点符号跳转到定义行", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view } = renderPane();
    await view.findByTestId("monaco-host");
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    // 面包屑路径段
    expect(view.getByText("src")).toBeInTheDocument();
    expect(view.getByText("a.ts")).toBeInTheDocument();
    // 光标移入符号范围 → 面包屑出现符号
    act(() => fake.editors[0].__emitCursor(2));
    const crumb = await view.findByRole("button", { name: /foo/ });
    fireEvent.click(crumb);
    expect(fake.editors[0].position).toEqual({ lineNumber: 1, column: 1 });
    expect(fake.editors[0].revealedLine).toBe(1);
    // 索引数据来自既有接口的 file 参数
    expect(fileSymbols).toHaveBeenCalledWith("s1", "src/a.ts");
  });

  it("索引不可用（501/409）→ 无符号面包屑，编辑器不受影响", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    fileSymbols.mockRejectedValue(new Error("Symbol index is not enabled"));
    const { view } = renderPane();
    await view.findByTestId("monaco-host");
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    act(() => fake.editors[0].__emitCursor(2));
    expect(view.queryByRole("button", { name: /foo/ })).toBeNull();
  });
});

describe("EditorPane：纯函数", () => {
  it("symbolAtLine 取包含光标的最内层符号", () => {
    const symbols = [
      { name: "outer", startLine: 1, endLine: 20 },
      { name: "inner", startLine: 5, endLine: 8 },
    ];
    expect(symbolAtLine(symbols, 6)?.name).toBe("inner");
    expect(symbolAtLine(symbols, 2)?.name).toBe("outer");
    expect(symbolAtLine(symbols, 21)).toBeUndefined();
  });

  it("monacoLanguageForPath 按扩展名匹配，未知回退 plaintext", () => {
    const fake = createFakeMonaco();
    expect(monacoLanguageForPath(fake.monaco, "src/a.ts")).toBe("typescript");
    expect(monacoLanguageForPath(fake.monaco, "README.md")).toBe("markdown");
    expect(monacoLanguageForPath(fake.monaco, "x.unknown")).toBe("plaintext");
  });
});

/**
 * App 层编辑器/diff/代码浮层集成：aux-views 驱动的挂载、三者互斥、
 * 键盘动作（mod+s 保存 / mod+\ 焦点切换 / Esc 关闭）、会话切换 closeAll。
 */

const fake = createFakeMonaco();

const session = makeSession({
  id: "s1",
  title: "编辑器集成",
  messages: [{ id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "打开文件看看" }] }],
});

const putCalls: string[] = [];

function installFetchMock(): void {
  installAppFetchMock({
    session,
    extra: (url, json) => {
      if (url.includes("/files/content")) return json({ content: "const a = 1;\n", encoding: "utf8", truncated: false, revision: "r1" });
      if (url.includes("/api/workspaces/symbols")) return json({ symbols: [] });
      return undefined;
    },
  });
  // 包一层记录 PUT（编辑器保存）
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PUT") putCalls.push(String(input));
    return inner(input, init);
  });
}

setupStubWebSocket();

describe("App 编辑器/diff/代码浮层集成", () => {
  beforeEach(() => {
    window.localStorage.clear();
    ui.selectSession(undefined);
    auxViews.closeAll();
    live.removeSession("s1");
    fake.editors.length = 0;
    fake.diffEditors.length = 0;
    putCalls.length = 0;
    // api 层 mock 接管 read/write（顶层 mock 工厂覆盖），值与 fetch 打桩路由一致
    loadMonacoMock.mockResolvedValue(fake.monaco);
    readFile.mockResolvedValue({ content: "const a = 1;\n", encoding: "utf8", truncated: false, revision: "r1" });
    fileSymbols.mockResolvedValue({ symbols: [], indexStatus: "fresh" });
    writeFile.mockImplementation(async () => {
      putCalls.push(`/api/sessions/${session.id}/files/content`);
      return { ok: true, revision: "r2" };
    });
  });

  async function launchApp(): Promise<void> {
    installFetchMock();
    renderWithClient(<App />);
    await screen.findByText("打开文件看看");
  }

  it("auxViews.openEditor 挂载编辑器分栏（对话并存），关闭后回到纯对话", async () => {
    await launchApp();

    act(() => auxViews.openEditor("src/a.ts", { line: 1 }));
    expect(await screen.findByTestId("monaco-host")).toBeInTheDocument();
    // 对话仍挂载（分栏而非替换）
    expect(document.querySelector(".wb-main-split > .workbench")).toBeInTheDocument();
    expect(fake.editors).toHaveLength(1);
    expect(fake.editors[0]!.value).toBe("const a = 1;\n");

    fireEvent.click(screen.getByRole("button", { name: /回到对话/ }));
    expect(screen.queryByTestId("monaco-host")).toBeNull();
    expect(auxViewsStore.get().editor).toBeUndefined();
  });

  it("三者互斥：editor → diff → codeOverlay 依次顶掉前一个", async () => {
    await launchApp();

    act(() => auxViews.openEditor("src/a.ts"));
    await screen.findByTestId("monaco-host");

    act(() => auxViews.openDiff({ source: "agent-write", path: "src/a.ts", content: "const a = 2;\n" }));
    expect(await screen.findByTestId("monaco-diff-host")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-host")).toBeNull();
    expect(auxViewsStore.get().editor).toBeUndefined();

    act(() => auxViews.openCodeOverlay("src/a.ts"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-diff-host")).toBeNull();
    expect(auxViewsStore.get().diff).toBeUndefined();

    // 浮层「编辑」升级为编辑器分栏（浮层关闭）
    fireEvent.click(screen.getByRole("button", { name: /在编辑器中打开/ }));
    expect(await screen.findByTestId("monaco-host")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(auxViewsStore.get()).toEqual({ editor: { path: "src/a.ts" }, diff: undefined, codeOverlay: undefined });
  });

  it("mod+s 触发编辑器保存（PUT files/content），mod+\\ 把焦点切到编辑器", async () => {
    await launchApp();

    act(() => auxViews.openEditor("src/a.ts"));
    await screen.findByTestId("monaco-host");

    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(fake.editors[0]!.focused).toBe(true);

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]).toContain("/api/sessions/s1/files/content");
  });

  it("Esc 关闭编辑器/diff 分栏并清空 aux-views", async () => {
    await launchApp();

    act(() => auxViews.openEditor("src/a.ts"));
    await screen.findByTestId("monaco-host");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(auxViewsStore.get().editor).toBeUndefined());
    expect(screen.queryByTestId("monaco-host")).toBeNull();

    act(() => auxViews.openDiff({ source: "agent-write", path: "src/a.ts", content: "const a = 2;\n" }));
    await screen.findByTestId("monaco-diff-host");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(auxViewsStore.get().diff).toBeUndefined());
    expect(screen.queryByTestId("monaco-diff-host")).toBeNull();
  });

  it("切换会话关闭全部辅助视图（布局回归约束）", async () => {
    await launchApp();

    act(() => auxViews.openEditor("src/a.ts"));
    await screen.findByTestId("monaco-host");

    act(() => ui.selectSession(undefined));
    await waitFor(() => expect(auxViewsStore.get().editor).toBeUndefined());
    expect(screen.queryByTestId("monaco-host")).toBeNull();
  });
});

const CURRENT = "line1\nline2 changed\nline3\n";
const ORIGINAL = "line1\nline2\nline3\n";
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

function renderDiffPane(spec: DiffSpec, props: Partial<Parameters<typeof DiffPane>[0]> = {}) {
  const onClose = vi.fn();
  const onNotice = vi.fn();
  const actionsRef: { current: { accept?(): void; reject?(): void; focus?(): void } } = { current: {} };
  const view = renderWithClient(
    <DiffPane
      sessionId="s1"
      spec={spec}
      dark
      actionsRef={actionsRef}
      onClose={onClose}
      onNotice={onNotice}
      {...props}
    />,
  );
  return { view, onClose, onNotice, actionsRef };
}

/**
 * DiffPane 单测（0.5.0 Phase 1b 验收）：
 * - 三种来源（SCM / 检查点 / agent 工具改动）同一组件打开；
 * - hunk 接受=保留（仅标记）、拒绝=内容写回走 api.writeFile（server 权限链入口，mock 断言参数）；
 * - plan 模式只读（无写按钮）；Monaco 加载失败降级文本 diff 且 hunk 操作仍可用；
 * - 检查点摘要后端降级；agent write_file 只读；Esc 回对话。
 * Monaco 本体用 fake（helpers/fake-monaco.ts），api 层 mock。
 */
describe("DiffPane 单测", () => {
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
      const { view } = renderDiffPane(spec);
      await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
      expect(fake.diffEditors[0].model?.original.value).toBe(ORIGINAL);
      expect(fake.diffEditors[0].model?.modified.value).toBe(CURRENT);
      // 接受：不写文件，只标记状态
      fireEvent.click(await view.findByRole("button", { name: "接受" }));
      expect(writeFile).not.toHaveBeenCalled();
      expect(await view.findByText("已接受")).toBeInTheDocument();
      expect(await view.findByText(/全部 hunk 已处理/)).toBeInTheDocument();
    });

    it("拒绝 hunk：内容写回走 api.writeFile（server 权限链），成功后标记并更新新侧（按钮与 actionsRef.reject 双触发）", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view, onNotice } = renderDiffPane(spec);
      await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
      fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
      await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
      expect(await view.findByText("已拒绝")).toBeInTheDocument();
      await waitFor(() => expect(onNotice.mock.calls.some(([message]) => String(message).includes("写回"))).toBe(true));

      // 命令动作面 actionsRef.reject 作用于首个待处理 hunk，走同一写回路径
      const fake2 = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake2.monaco);
      const { view: view2, actionsRef } = renderDiffPane(spec);
      const pane2 = within(view2.container);
      await waitFor(() => expect(fake2.diffEditors).toHaveLength(1));
      const writesBefore = writeFile.mock.calls.length;
      act(() => actionsRef.current.reject?.());
      await waitFor(() => expect(writeFile.mock.calls.length).toBeGreaterThan(writesBefore));
      expect(writeFile).toHaveBeenLastCalledWith("s1", "src/a.ts", ORIGINAL, REVISION);
      expect(await pane2.findByText("已拒绝")).toBeInTheDocument();
    });

    it("写回被 server 拒绝（plan/权限 403）：hunk 保持待处理并提示错误", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      writeFile.mockRejectedValue(new Error("Plan 模式为只读：write_file 被拦截"));
      const { view, onNotice } = renderDiffPane(spec);
      await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
      fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Plan 模式为只读"), "error"));
      expect(view.getByText("待处理")).toBeInTheDocument();
    });

    it("hunk 还原失败（HunkRevertError）：英文界面提示为英文，不直出中文错误消息", async () => {
      window.localStorage.setItem("owc-language", "en");
      // 只拦截 UI 侧调用；模块内 reconstructOriginal 走的是内部引用，不受影响
      const spy = vi.spyOn(unifiedDiff, "revertHunks").mockImplementation(() => {
        throw new unifiedDiff.HunkRevertError("hunk-content-mismatch", "hunk does not match current file content: @@ -1,3 +1,3 @@");
      });
      try {
        const fake = createFakeMonaco();
        loadMonacoMock.mockResolvedValue(fake.monaco);
        const onNotice = vi.fn();
        const view = renderWithClient(
          <I18nProvider>
            <DiffPane sessionId="s1" spec={spec} dark onClose={vi.fn()} onNotice={onNotice} />
          </I18nProvider>,
        );
        await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
        fireEvent.click(await view.findByRole("button", { name: "Reject" }));
        await waitFor(() => expect(onNotice).toHaveBeenCalled());
        expect(writeFile).not.toHaveBeenCalled();
        for (const [message, kind] of onNotice.mock.calls) {
          expect(kind).toBe("error");
          expect(String(message)).not.toMatch(/[一-鿿]/);
        }
      } finally {
        spy.mockRestore();
        window.localStorage.removeItem("owc-language");
      }
    });

    it("已暂存改动：只读并如实提示（内容写回无法触及索引）", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view } = renderDiffPane({ source: "scm", path: "src/a.ts", staged: true });
      expect(await view.findByText(/已暂存的改动位于 git 索引中/)).toBeInTheDocument();
      expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
      expect(view.getByTestId("diff-fallback")).toBeInTheDocument();
    });

    it("plan 模式：隐藏 hunk 写按钮并提示只读", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view } = renderDiffPane(spec, { readOnly: true });
      expect(await view.findByText(/Plan 模式为只读/)).toBeInTheDocument();
      await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
      expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
      expect(view.queryByRole("button", { name: "接受" })).toBeNull();
    });

  });

  describe("DiffPane：检查点来源", () => {
    const spec: DiffSpec = { source: "checkpoint", checkpointId: "a".repeat(40), label: "cp" };

    it("unified diff 可解析：hunk 拒绝=恢复到此 hunk（写回旧侧内容）", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view } = renderDiffPane(spec);
      await waitFor(() => expect(fake.diffEditors).toHaveLength(1));
      expect(fake.diffEditors[0].model?.original.value).toBe(ORIGINAL);
      fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
      await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
    });

    it("后端只给摘要（非 unified diff）：摘要模式展示原文，无 hunk 操作", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      checkpointDiff.mockResolvedValue({ diff: "M\t/ws/a.txt" });
      const { view } = renderDiffPane(spec);
      expect(await view.findByText(/只提供差异摘要/)).toBeInTheDocument();
      expect(view.queryByRole("button", { name: "拒绝" })).toBeNull();
    });
  });

  describe("DiffPane：agent 工具改动来源", () => {
    it("edit_file：拒绝=写回改动前内容（oldText 还原）", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view } = renderDiffPane({ source: "agent-edit", path: "src/a.ts", oldText: "line2", newText: "line2 changed" });
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
      const { view } = renderDiffPane({ source: "agent-edit", path: "src/a.ts", oldText: "line2", newText: "line2 changed" });
      expect(await view.findByText(/已找不到该工具改动/)).toBeInTheDocument();
      expect(view.queryByRole("button", { name: "拒绝改动" })).toBeNull();
    });

    it("write_file：无改动前内容，只读展示写入结果", async () => {
      const fake = createFakeMonaco();
      loadMonacoMock.mockResolvedValue(fake.monaco);
      const { view } = renderDiffPane({ source: "agent-write", path: "src/a.ts", content: "written\n" });
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
      const { view } = renderDiffPane(spec);
      fireEvent.click(await view.findByRole("button", { name: "拒绝" }));
      await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", ORIGINAL, REVISION));
      expect(await view.findByTestId("diff-fallback-content")).toBeInTheDocument();
    });

    it("Esc（Monaco 外焦点）→ onClose 回对话", async () => {
      loadMonacoMock.mockRejectedValue(new Error("chunk load failed"));
      const { view, onClose } = renderDiffPane(spec);
      await view.findByRole("button", { name: "拒绝" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
