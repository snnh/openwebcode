import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "../components/NewSessionDialog";

// jsdom 对 HTMLDialogElement.showModal/close 的实现不完整：打桩为 open 属性开关
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(managed: { available: boolean; detail?: string }): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sandbox/capabilities")) return json({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" } });
    if (url.endsWith("/api/managed-workspace/capability")) {
      return json({ platform: "linux", backends: [{ backend: "qcow2", available: managed.available, requiresAdmin: true, ...(managed.detail ? { detail: managed.detail } : {}) }] });
    }
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

function renderDialog(): void {
  render(
    <NewSessionDialog
      open
      providers={["development"]}
      models={[]}
      onClose={() => undefined}
      onCreate={() => undefined}
    />,
  );
}

describe("NewSessionDialog 工作区模式", () => {
  it("渲染工作区模式下拉；后端可用时托管选项可选，选中后 cwd 变为源目录并展示说明", async () => {
    stubFetch({ available: true });
    renderDialog();
    const label = await screen.findByText("工作区模式");
    const select = within(label.closest("label")!).getByRole("combobox");
    const managed = within(select).getByRole("option", { name: /托管工作区/ });
    await waitFor(() => expect(managed).not.toBeDisabled());

    fireEvent.change(select, { target: { value: "managed" } });
    expect(await screen.findByText("源目录（将复制进托管工作区）")).toBeInTheDocument();
    expect(screen.getByText(/20GB 稀疏镜像盘/)).toBeInTheDocument();
  });

  it("后端不可用时托管选项禁用并带原因 tooltip", async () => {
    stubFetch({ available: false, detail: "不可用：缺少 免密 sudo" });
    renderDialog();
    const label = await screen.findByText("工作区模式");
    const select = within(label.closest("label")!).getByRole("combobox");
    const managed = within(select).getByRole("option", { name: /托管工作区/ });
    await waitFor(() => expect(managed).toBeDisabled());
    expect(managed).toHaveAttribute("title", expect.stringContaining("sudo"));
    expect(await screen.findByText(/托管工作区不可用/)).toBeInTheDocument();
    // 默认仍是直接模式，cwd label 不变
    expect(screen.getByText("工作目录")).toBeInTheDocument();
  });
});
