import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "../components/NewSessionDialog";
import type { ModelProfile } from "../lib/contracts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(managed: { available: boolean; detail?: string }, bindLink: { available: boolean; reason?: string } = { available: false, reason: "未启用" }): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sandbox/capabilities")) return json({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" }, bindLink });
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
      providers={["test-stub"]}
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
    expect(screen.getByText(/关闭或删除会话时自动覆盖/)).toBeInTheDocument();
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

describe("NewSessionDialog Bind Link", () => {
  const model = { id: "m", provider: "test-stub", contextWindow: 1000, maxOutput: 100, capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true } } as ModelProfile;

  it("添加绑定并随创建提交 bindLinks（未填完整的行被忽略）", async () => {
    stubFetch({ available: true }, { available: true });
    const onCreate = vi.fn();
    render(<NewSessionDialog open providers={["test-stub"]} models={[model]} onClose={() => undefined} onCreate={onCreate} />);
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    const addButton = await screen.findByRole("button", { name: "添加绑定" });
    await waitFor(() => expect(addButton).toBeEnabled());
    fireEvent.click(addButton); // 这一行留空，提交时应被忽略
    fireEvent.click(addButton);
    fireEvent.change(screen.getAllByLabelText("沙盒内路径")[1]!, { target: { value: " C:\\mnt\\shared " } });
    fireEvent.change(screen.getAllByLabelText("宿主目录")[1]!, { target: { value: "D:\\shared" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      cwd: "D:\\work",
      bindLinks: [{ virtPath: "C:\\mnt\\shared", backingPath: "D:\\shared", readOnly: true }],
    });
  });

  it("能力不可用时添加按钮禁用并展示原因", async () => {
    stubFetch({ available: true }, { available: false, reason: "需要 Windows 11 24H2+" });
    render(<NewSessionDialog open providers={["test-stub"]} models={[model]} onClose={() => undefined} onCreate={() => undefined} />);
    const addButton = await screen.findByRole("button", { name: "添加绑定" });
    await waitFor(() => expect(addButton).toBeDisabled());
    expect(await screen.findByText(/Bind Link 不可用/)).toBeInTheDocument();
    expect(screen.getByText(/需要 Windows 11 24H2\+/)).toBeInTheDocument();
  });

  it("wsb 与关闭沙盒模式下不展示绑定编辑器", async () => {
    stubFetch({ available: true }, { available: true });
    render(<NewSessionDialog open providers={["test-stub"]} models={[model]} onClose={() => undefined} onCreate={() => undefined} />);
    const sandboxLabel = await screen.findByText("沙盒模式");
    const select = within(sandboxLabel.closest("label")!).getByRole("combobox");

    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "添加绑定" })).not.toBeInTheDocument());

    fireEvent.change(select, { target: { value: "wsb" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "添加绑定" })).not.toBeInTheDocument());

    fireEvent.change(select, { target: { value: "jobobject" } });
    expect(await screen.findByRole("button", { name: "添加绑定" })).toBeInTheDocument();
  });
});

describe("NewSessionDialog provider 引导", () => {
  it("没有已配置 provider 时说明原因并禁用创建", async () => {
    stubFetch({ available: true });
    render(
      <NewSessionDialog
        open
        providers={[]}
        models={[]}
        onClose={() => undefined}
        onCreate={() => undefined}
      />,
    );
    expect(await screen.findByText(/还没有可用的 Provider/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByLabelText("模型")).toBeDisabled();
  });

  it("provider 尚未有模型目录时不伪造模型并禁用创建", async () => {
    stubFetch({ available: true });
    renderDialog();
    expect(await screen.findByText(/已启用的服务商尚无可用模型/)).toBeInTheDocument();
    expect(screen.getByLabelText("模型")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
  });

  it("已选服务商从列表移除时切换到新的可用模型记录", async () => {
    stubFetch({ available: true });
    const anthropic = { id: "claude", provider: "anthropic", contextWindow: 1000, maxOutput: 100, capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true } } as ModelProfile;
    const openai = { ...anthropic, id: "gpt", provider: "openai" };
    const { rerender } = render(
      <NewSessionDialog open providers={["anthropic"]} models={[anthropic, openai]} onClose={() => undefined} onCreate={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue(JSON.stringify(["anthropic", "claude"])));

    rerender(
      <NewSessionDialog open providers={["openai"]} models={[anthropic, openai]} onClose={() => undefined} onCreate={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue(JSON.stringify(["openai", "gpt"])));
  });

  it("在模型选择器旁显示所选模型的图片、视频输入和图片输出能力", async () => {
    stubFetch({ available: true });
    const models: ModelProfile[] = [
      {
        id: "multimodal",
        displayName: "Multimodal",
        provider: "test-stub",
        contextWindow: 128_000,
        maxOutput: 16_384,
        capabilities: { thinking: [], effort: [], modalities: ["text", "image", "video"], imageOutput: true, tools: true },
      },
      {
        id: "text-only",
        displayName: "Text only",
        provider: "test-stub",
        contextWindow: 128_000,
        maxOutput: 16_384,
        capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
      },
    ];
    render(<NewSessionDialog open providers={["test-stub"]} models={models} onClose={() => undefined} onCreate={() => undefined} />);

    expect(await screen.findByText("图片输入")).toBeInTheDocument();
    expect(screen.getByText("视频输入")).toBeInTheDocument();
    expect(screen.getByText("图片输出")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("模型"), { target: { value: JSON.stringify(["test-stub", "text-only"]) } });
    await waitFor(() => expect(screen.queryByText("图片输入")).not.toBeInTheDocument());
    expect(screen.queryByText("视频输入")).not.toBeInTheDocument();
    expect(screen.queryByText("图片输出")).not.toBeInTheDocument();
  });
});
