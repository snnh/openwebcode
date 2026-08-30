import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { NewSessionDialog } from "../components/NewSessionDialog";
import type { ModelProfile } from "../lib/contracts";
import { makeTestClient, renderWithClient } from "./helpers/with-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubModel = { id: "m", provider: "test-stub", contextWindow: 1000, capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true } } as ModelProfile;

function stubFetch(
  managed: { available: boolean; detail?: string },
  bindLink: { available: boolean; reason?: string } = { available: false, reason: "未启用" },
  platform = "win32",
): void {
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sandbox/capabilities")) return json({ platform, appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "未启用" }, bindLink, bwrap: { available: true } });
    if (url.endsWith("/api/managed-workspace/capability")) {
      return json({ platform: "linux", backends: [{ backend: "qcow2", available: managed.available, requiresAdmin: true, ...(managed.detail ? { detail: managed.detail } : {}) }] });
    }
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

function renderDialog(props: Partial<ComponentProps<typeof NewSessionDialog>> = {}): void {
  renderWithClient(
    <NewSessionDialog
      open
      providers={["test-stub"]}
      models={[]}
      onClose={() => undefined}
      onCreate={() => undefined}
      {...props}
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
  it("添加绑定并随创建提交 bindLinks（未填完整的行被忽略）", async () => {
    stubFetch({ available: true }, { available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
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
    renderDialog({ models: [stubModel] });
    const addButton = await screen.findByRole("button", { name: "添加绑定" });
    await waitFor(() => expect(addButton).toBeDisabled());
    expect(await screen.findByText(/Bind Link 不可用/)).toBeInTheDocument();
    expect(screen.getByText(/需要 Windows 11 24H2\+/)).toBeInTheDocument();
  });

  it("wsb 与关闭沙盒模式下不展示绑定编辑器", async () => {
    stubFetch({ available: true }, { available: true });
    renderDialog({ models: [stubModel] });
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
    renderDialog({ providers: [] });
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
    const anthropic = { id: "claude", provider: "anthropic", contextWindow: 1000, capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true } } as ModelProfile;
    const openai = { ...anthropic, id: "gpt", provider: "openai" };
    const client = makeTestClient();
    const { rerender } = renderWithClient(
      <NewSessionDialog open providers={["anthropic"]} models={[anthropic, openai]} onClose={() => undefined} onCreate={() => undefined} />,
      client,
    );
    await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue(JSON.stringify(["anthropic", "claude"])));

    rerender(
      <QueryClientProvider client={client}>
        <NewSessionDialog open providers={["openai"]} models={[anthropic, openai]} onClose={() => undefined} onCreate={() => undefined} />
      </QueryClientProvider>,
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
        capabilities: { thinking: [], effort: [], modalities: ["text", "image", "video"], imageOutput: true, tools: true },
      },
      {
        id: "text-only",
        displayName: "Text only",
        provider: "test-stub",
        contextWindow: 128_000,
        capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
      },
    ];
    renderDialog({ models });

    expect(await screen.findByText("图片输入")).toBeInTheDocument();
    expect(screen.getByText("视频输入")).toBeInTheDocument();
    expect(screen.getByText("图片输出")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("模型"), { target: { value: JSON.stringify(["test-stub", "text-only"]) } });
    await waitFor(() => expect(screen.queryByText("图片输入")).not.toBeInTheDocument());
    expect(screen.queryByText("视频输入")).not.toBeInTheDocument();
    expect(screen.queryByText("图片输出")).not.toBeInTheDocument();
  });
});

describe("NewSessionDialog 工具限制", () => {
  it("填写白名单/黑名单后随创建提交 toolsAllow/toolsDeny（逗号分隔、逐项 trim、空项丢弃）", async () => {
    stubFetch({ available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });
    fireEvent.change(screen.getByLabelText(/工具白名单/), { target: { value: "read_file, grep ," } });
    fireEvent.change(screen.getByLabelText(/工具黑名单/), { target: { value: "bash" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ toolsAllow: ["read_file", "grep"], toolsDeny: ["bash"] });
  });

  it("留空 = 不限制：不提交 toolsAllow/toolsDeny 字段", async () => {
    stubFetch({ available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("toolsAllow");
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("toolsDeny");
  });
});

describe("NewSessionDialog 备选模型", () => {
  const primary = { ...stubModel, id: "m1" };
  const backup = { ...stubModel, id: "m2" };

  it("添加备选行（默认取第一个非主模型，选项不含主模型）并随创建提交 fallbackModels", async () => {
    stubFetch({ available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [primary, backup], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    fireEvent.click(await screen.findByRole("button", { name: "添加备选" }));
    const rowSelect = await screen.findByLabelText("备选模型");
    // 备选选项不含当前主模型
    expect(within(rowSelect).queryByRole("option", { name: /m1/ })).not.toBeInTheDocument();
    expect(rowSelect).toHaveValue(JSON.stringify(["test-stub", "m2"]));
    expect(await screen.findByText(/可恢复错误重试耗尽后/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ fallbackModels: [{ provider: "test-stub", model: "m2" }] });
  });

  it("未添加备选行：不提交 fallbackModels 字段", async () => {
    stubFetch({ available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [primary, backup], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("fallbackModels");
  });

  it("备选行选成与主模型相同后，提交时剔除（不提交重复项）", async () => {
    stubFetch({ available: true });
    const onCreate = vi.fn();
    renderDialog({ models: [primary, backup], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    fireEvent.click(await screen.findByRole("button", { name: "添加备选" }));
    const rowSelect = await screen.findByLabelText("备选模型");
    // 把主模型切到 m2（与已添加的备选行重复）
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: JSON.stringify(["test-stub", "m2"]) } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("fallbackModels");
    expect(rowSelect).toBeInTheDocument();
  });
});

describe("NewSessionDialog 平台适配", () => {
  function sandboxSelect(): HTMLElement {
    const label = screen.getByText("沙盒模式");
    return within(label.closest("label")!).getByRole("combobox");
  }

  it("win32：默认选中 AppContainer（带默认标注）且提交不携带 sandboxMode；展示 Job Object/WSB 选项、WSB 不可用提示与 Bind Link 区块", async () => {
    stubFetch({ available: true }, { available: true }, "win32");
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    const select = await screen.findByText("沙盒模式").then(sandboxSelect);
    await waitFor(() => expect(within(select).getByRole("option", { name: /AppContainer/ })).toBeInTheDocument());
    expect(within(select).getByRole("option", { name: /AppContainer/ })).toHaveTextContent("默认");
    expect(select).toHaveValue("appcontainer");
    expect(within(select).getByRole("option", { name: /Job Object/ })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /Job Object/ })).not.toHaveTextContent("默认");
    expect(within(select).getByRole("option", { name: /Windows Sandbox/ })).toBeInTheDocument();
    expect(await screen.findByText(/Windows Sandbox 不可用/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "添加绑定" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("sandboxMode");
  });

  it("linux：沙盒选项为 landlock/bubblewrap/off 真值，默认选中 bubblewrap（内部默认 appcontainer 映射）；隐藏 AppContainer/WSB 选项、WSB 提示与整个 Bind Link 区块", async () => {
    stubFetch({ available: true }, { available: true }, "linux");
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "/home/me/demo" } });

    const select = await screen.findByText("沙盒模式").then(sandboxSelect);
    await waitFor(() => expect(within(select).getByRole("option", { name: /Landlock/ })).toBeInTheDocument());
    expect(within(select).getByRole("option", { name: /bubblewrap/ })).toBeInTheDocument();
    expect(select).toHaveValue("bubblewrap");
    expect(within(select).queryByRole("option", { name: /AppContainer/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /Windows Sandbox/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Windows Sandbox 不可用/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加绑定" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Bind Link/)).not.toBeInTheDocument();

    // 默认（内部 appcontainer）提交不带 sandboxMode；显式选择 landlock 才提交真值
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("sandboxMode");

    fireEvent.change(select, { target: { value: "landlock" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]?.[0]).toMatchObject({ sandboxMode: "landlock" });
  });
});

describe("NewSessionDialog 网络策略", () => {
  function networkSelect(): HTMLElement {
    const label = screen.getByText("网络");
    return within(label.closest("label")!).getByRole("combobox");
  }

  it("win32：提供允许/拒绝/代理过滤选项；默认 allow 不提交 network", async () => {
    stubFetch({ available: true }, { available: true }, "win32");
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });

    const select = await screen.findByText("网络").then(networkSelect);
    expect(within(select).getByRole("option", { name: /允许/ })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "拒绝" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /代理过滤/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("network");
  });

  it.each([
    { value: "deny", hint: null },
    { value: "filtered", hint: /经代理过滤出网/ },
  ])("选择 $value 时随创建提交对应 network 策略", async ({ value, hint }) => {
    stubFetch({ available: true }, { available: true }, "win32");
    const onCreate = vi.fn();
    renderDialog({ models: [stubModel], onCreate });
    fireEvent.change(await screen.findByLabelText("工作目录"), { target: { value: "D:\\work" } });
    fireEvent.change(await screen.findByText("网络").then(networkSelect), { target: { value } });
    if (hint) expect(await screen.findByText(hint)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ network: value });
  });

  it("linux：不提供代理过滤选项", async () => {
    stubFetch({ available: true }, { available: true }, "linux");
    renderDialog({ models: [stubModel] });

    const select = await screen.findByText("网络").then(networkSelect);
    expect(within(select).queryByRole("option", { name: /代理过滤/ })).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "拒绝" })).toBeInTheDocument();
  });
});
