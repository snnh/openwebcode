/**
 * EditorPane 单测（0.5.0 Phase 1a 验收）：
 * Monaco 加载失败降级只读视图；保存走既有写路径（api.writeFile → server 权限链）；
 * plan 模式只读门禁；面包屑路径 + 光标符号。
 * Monaco 本体用 fake（见 helpers/fake-monaco.ts），api 层 mock 断言请求参数。
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { EditorPane, monacoLanguageForPath, symbolAtLine } from "../components/editor/EditorPane";
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
      workspaceFileSymbols: vi.fn(),
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

const FILE = { content: "export function foo() {\n  return 1;\n}\n", encoding: "utf-8", truncated: false };
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
  writeFile.mockResolvedValue({ ok: true });
  fileSymbols.mockResolvedValue({ ...SYMBOLS });
});

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
  it("修改后点保存 → api.writeFile（server 端权限/路径策略/plan 门禁入口），成功清脏并提示", async () => {
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
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", "export function foo() {\n  return 2;\n}\n"));
    await waitFor(() => expect(onNotice.mock.calls.some(([message]) => String(message).includes("已保存"))).toBe(true));
    await waitFor(() => expect(view.getByRole("button", { name: "保存" })).toBeDisabled());
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

  it("App 命令动作面：actionsRef.save 触发同一保存路径", async () => {
    const fake = createFakeMonaco();
    loadMonacoMock.mockResolvedValue(fake.monaco);
    const { view, actionsRef } = renderPane();
    await view.findByTestId("monaco-host");
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    act(() => {
      fake.editors[0].value = "via-command";
      fake.editors[0].__emitContent();
    });
    act(() => actionsRef.current.save?.());
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("s1", "src/a.ts", "via-command"));
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
