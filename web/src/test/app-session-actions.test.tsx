import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../components/EmptyState";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

const session = makeSession();

interface RecordedCall { url: string; method: string }

const calls: RecordedCall[] = [];

function installFetchMock(): void {
  calls.length = 0;
  installAppFetchMock({ session, models: [] });
  // 包一层记录 method（DELETE/POST 断言需要）；GET/DELETE 路由仍走标准 mock
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method ?? "GET" });
    return inner(input, init);
  });
}

setupStubWebSocket();

describe("App 会话操作与 /help", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
    // jsdom 无布局：Composer 弹层/轨道的滚动定位打桩
    Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op */ };
  });

  it("/help：打开快捷键速查、清空草稿、不发送消息", async () => {
    installFetchMock();
    renderApp();
    const textarea = await screen.findByRole("combobox", { name: /消息输入框/ });
    fireEvent.change(textarea, { target: { value: "/help" } });
    // 第一次 Enter 采纳补全建议（写入 "/help "），第二次才真正发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    // 设置对话框打开并定位到「快捷键」页签（速查浮层已并入设置）
    expect(await screen.findByText("键盘快捷方式")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(calls.some((call) => call.url.includes("/api/sessions/s1/messages") && call.method === "POST")).toBe(false);
  });

  it("删除会话走样式化确认框：取消不发 DELETE，确认才发", async () => {
    installFetchMock();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "删除会话 测试作业" }));
    // 确认框出现；原生 confirm 未触达
    expect(await screen.findByText(/删除会话「测试作业」？/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    // 再次打开并确认
    fireEvent.click(await screen.findByRole("button", { name: "删除会话 测试作业" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/api/sessions/s1"))).toBe(true));
    confirmSpy.mockRestore();
  });
});

describe("EmptyState 示例任务 chips", () => {
  it("点击 chip 把任务文案交给 onExample", () => {
    const onExample = vi.fn();
    render(
      <EmptyState
        sessions={[]}
        providers={["anthropic"]}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onExample={onExample}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "解释这个仓库的结构" }));
    expect(onExample).toHaveBeenCalledWith("解释这个仓库的结构");
    fireEvent.click(screen.getByRole("button", { name: "修一个 failing test 并给出原因" }));
    expect(onExample).toHaveBeenCalledWith("修一个 failing test 并给出原因");
  });

  it("未提供 onExample 时不渲染 chips", () => {
    render(<EmptyState sessions={[]} providers={["anthropic"]} onSelect={() => undefined} onCreate={() => undefined} />);
    expect(screen.queryByText("试试这些任务")).toBeNull();
  });
});
