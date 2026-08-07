import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { live } from "../app/live-store";
import { ui } from "../app/ui-store";
import { auxViews, auxViewsStore } from "../workbench/aux-views";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { createFakeMonaco } from "./helpers/fake-monaco";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

/**
 * App 层编辑器/diff/代码浮层集成：aux-views 驱动的挂载、三者互斥、
 * 键盘动作（mod+s 保存 / mod+\ 焦点切换 / Esc 关闭）、会话切换 closeAll。
 */

const fake = createFakeMonaco();
vi.mock("../components/editor/monaco-loader", () => ({
  loadMonaco: () => Promise.resolve(fake.monaco),
}));

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
