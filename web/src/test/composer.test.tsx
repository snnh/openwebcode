import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../composer/Composer";
import { AgentModeMenu, ModelMenu, PermissionModeMenu } from "../composer/popovers";
import { clearComposerState } from "../composer/drafts";
import { qk } from "../app/queries";
import { setSendKey } from "../app/prefs-store";
import { ui } from "../app/ui-store";
import { App } from "../app/App";
import { api } from "../lib/api";
import type { ExtensionInfo, ModelProfile } from "../lib/contracts";
import type { ComposerProps } from "../chat/types";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeModelProfile, makeSession } from "./helpers/fixtures";
import { makeTestClient } from "./helpers/with-client";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderWithClient } from "./helpers/with-client";

const IMAGE_CAPS: ModelProfile["capabilities"] = { thinking: [], effort: [], modalities: ["text", "image"], imageOutput: false, tools: true };
const TEXT_CAPS: ModelProfile["capabilities"] = { ...IMAGE_CAPS, modalities: ["text"] };

/** 默认模型目录：当前会话模型（anthropic/claude-opus-4-8）支持图片输入。 */
function stubApi(models: ModelProfile[] = [makeModelProfile({ capabilities: IMAGE_CAPS })]): void {
  vi.spyOn(api, "models").mockResolvedValue(models);
  vi.spyOn(api, "providers").mockResolvedValue(["anthropic"]);
  vi.spyOn(api, "skills").mockResolvedValue({ skills: [] });
  vi.spyOn(api, "extensions").mockResolvedValue([]);
}

beforeEach(() => {
  window.localStorage.clear();
  clearComposerState("s1");
  setSendKey("enter");
  stubApi();
  // toast/通知中心在模块级 uiStore，用例间需清理避免串扰
  ui.setNotice(undefined);
  ui.clearNotifications();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    session: makeSession(),
    running: false,
    onSend: vi.fn(),
    onConfig: vi.fn(),
    onCancelEdit: vi.fn(),
    ...overrides,
  };
  const client = makeTestClient();
  const utils = render(<QueryClientProvider client={client}><Composer {...props} /></QueryClientProvider>);
  const textarea = screen.getByRole("combobox", { name: /消息输入框/ }) as HTMLTextAreaElement;
  return { props, client, textarea, ...utils };
}

/** 等模型目录进入缓存并刷新到组件渲染：supportsImages 依赖它，附件用例必须先等。 */
async function waitModelsLoaded(client: ReturnType<typeof makeTestClient>): Promise<void> {
  await waitFor(() => expect(client.getQueryData(qk.models)).toBeDefined());
  await act(async () => {});
}

function png(name: string): File {
  return new File(["png-bytes"], name, { type: "image/png" });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("隐藏文件输入框未渲染");
  return input as HTMLInputElement;
}

describe("Composer 渲染与发送", () => {
  it("渲染输入框（id=composer-input）与发送键提示占位符", () => {
    const { textarea } = renderComposer();
    expect(textarea.id).toBe("composer-input");
    expect(textarea.placeholder).toContain("Enter 发送");
    expect(textarea.placeholder).toContain("Shift+Enter 换行");
  });

  it("sendKey=ctrl-enter 时占位符切换提示", () => {
    setSendKey("ctrl-enter");
    const { textarea } = renderComposer();
    expect(textarea.placeholder).toContain("Ctrl+Enter 发送");
  });

  it("sendKey=ctrl-enter 时：回车换行不发送，Ctrl+Enter 才发送（选项真实生效）", () => {
    setSendKey("ctrl-enter");
    const { props, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "修 bug" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith("start");
  });

  it("输入后 Enter 触发 onSend('start')", () => {
    const { props, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "修个 bug" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith("start");
  });

  it("输入后点击发送按钮触发 onSend('start')", () => {
    const { props, textarea } = renderComposer();
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "跑一下测试" } });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);
    expect(props.onSend).toHaveBeenCalledWith("start");
  });

  it("Shift+Enter 不发送（换行）", () => {
    const { props, textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: "多行" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("运行中显示 Steering 提示，发送行为推导为 steer", () => {
    const { props, textarea } = renderComposer({ running: true });
    expect(screen.getByText("运行中 · 发送将进入 Steering 队列")).toBeInTheDocument();
    expect(textarea.placeholder).toContain("向正在执行的作业补充指令");
    fireEvent.change(textarea, { target: { value: "补充指令" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledWith("steer");
    fireEvent.click(screen.getByRole("button", { name: "加入队列" }));
    expect(props.onSend).toHaveBeenCalledTimes(2);
  });
});

describe("Composer 附件", () => {
  it("经文件选择添加图片附件并可移除", async () => {
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.change(fileInput(container), { target: { files: [png("a.png"), png("b.png")] } });
    expect(await screen.findByLabelText("移除附件 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("移除附件 2")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("移除附件 1"));
    await waitFor(() => expect(screen.queryByLabelText("移除附件 2")).not.toBeInTheDocument());
    expect(screen.getByLabelText("移除附件 1")).toBeInTheDocument();
  });

  it("粘贴图片同样进入附件列表", async () => {
    const { textarea, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.paste(textarea, { clipboardData: { files: [png("clip.png")], getData: () => "" } });
    expect(await screen.findByLabelText("移除附件 1")).toBeInTheDocument();
  });

  it("超过 4 张上限时提示且不追加", async () => {
    const notifySpy = vi.spyOn(ui, "notify");
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.change(fileInput(container), { target: { files: [png("1.png"), png("2.png"), png("3.png"), png("4.png")] } });
    expect(await screen.findByLabelText("移除附件 4")).toBeInTheDocument();
    fireEvent.change(fileInput(container), { target: { files: [png("5.png")] } });
    await waitFor(() => expect(notifySpy).toHaveBeenCalledWith("最多附带 4 张图片", "error"));
    expect(screen.queryByLabelText("移除附件 5")).not.toBeInTheDocument();
  });

  it("当前模型不支持图片输入时拒绝图片附件并提示", async () => {
    stubApi([makeModelProfile({ capabilities: TEXT_CAPS })]);
    const notifySpy = vi.spyOn(ui, "notify");
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.change(fileInput(container), { target: { files: [png("nope.png")] } });
    await waitFor(() => expect(notifySpy).toHaveBeenCalledWith("当前模型不支持图片输入", "error"));
    expect(screen.queryByLabelText(/移除附件/)).not.toBeInTheDocument();
  });

  it("vision-tools 扩展启用并配置视觉模型时，纯文本主模型允许添加图片", async () => {
    stubApi([makeModelProfile({ capabilities: TEXT_CAPS })]);
    vi.spyOn(api, "extensions").mockResolvedValue([{ id: "vision-tools", enabled: true, config: { model: "vision-stub/vl" } } as unknown as ExtensionInfo]);
    const notifySpy = vi.spyOn(ui, "notify");
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.change(fileInput(container), { target: { files: [png("bridge.png")] } });
    expect(await screen.findByLabelText("移除附件 1")).toBeInTheDocument();
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe("Composer 编辑重发", () => {
  it("显示横幅（含附件提示），按钮与 Esc 均可取消", () => {
    const onCancelEdit = vi.fn();
    const { textarea } = renderComposer({ editingMessage: { messageId: "m1", hadAttachments: true }, onCancelEdit });
    expect(screen.getByText(/正在编辑早前消息/)).toBeInTheDocument();
    expect(screen.getByText(/原消息的附件不会重发/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重发" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalledTimes(2);
  });

  it("无附件的原消息不显示附件提示", () => {
    renderComposer({ editingMessage: { messageId: "m2", hadAttachments: false } });
    expect(screen.getByText(/正在编辑早前消息/)).toBeInTheDocument();
    expect(screen.queryByText(/原消息的附件不会重发/)).not.toBeInTheDocument();
  });
});

function renderModelMenu(overrides: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  const props: Parameters<typeof ModelMenu>[0] = {
    current: { provider: "anthropic", model: "claude-opus-4-8" },
    selectableModels: [makeModelProfile()],
    selectionUnavailable: false,
    effortLevels: ["low", "high"],
    showEffortSlider: true,
    thinkingOn: false,
    defaultOnValue: "mode:enabled",
    thinkingControlSupported: true,
    disabled: false,
    onSelectModel: vi.fn(),
    onSelectThinking: vi.fn(),
    onOpenModelSettings: vi.fn(),
    ...overrides,
  };
  render(<ModelMenu {...props} />);
  return props;
}

describe("PermissionModeMenu", () => {
  it("打开后列出四档，当前值高亮，选择非 yolo 档触发 onChange 并关闭", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options).toHaveLength(4);
    expect(screen.getByRole("menuitemradio", { name: /逐次确认/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /完全自主/ })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /接受编辑/ }));
    expect(onChange).toHaveBeenCalledWith("acceptEdits");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("选择 yolo 先弹风险确认：勾选后才可确认，确认才切换", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    // 弹层关闭、对话框打开，未勾选前确认禁用且不触发 onChange
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "切换到完全自主？" });
    expect(dialog).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "切换到完全自主" });
    expect(confirm).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onChange).not.toHaveBeenCalled();
    // 勾选「我已了解风险」后确认可用
    fireEvent.click(screen.getByRole("checkbox", { name: /我已了解风险/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("yolo 确认框取消：不切换；已是 yolo 时重选不再弹确认", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PermissionModeMenu value="ask" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 已是 yolo：再次选择当前值直接走原路径（仍是 yolo，不重复弹确认）
    rerender(<PermissionModeMenu value="yolo" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("yolo");
  });

  it("Esc 关闭弹层，不改变取值", () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu value="review" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    expect(screen.getByRole("menuitemradio", { name: /模型审核/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled 时触发按钮不可点", () => {
    render(<PermissionModeMenu value="ask" disabled onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "权限模式" })).toBeDisabled();
  });
});

describe("AgentModeMenu", () => {
  it("计划/目标写入互斥的 agentMode，Swarm 写独立开关", () => {
    const onConfig = vi.fn();
    render(<AgentModeMenu agentMode={undefined} swarmEnabled={false} disabled={false} onConfig={onConfig} />);
    fireEvent.click(screen.getByRole("button", { name: "模式" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "plan" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Swarm" }));
    expect(onConfig).toHaveBeenCalledWith({ swarmEnabled: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "目标" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "goal" });
  });

  it("已激活的模式在按钮徽标与开关态上体现，再次点击计划清除", () => {
    const onConfig = vi.fn();
    render(<AgentModeMenu agentMode="plan" swarmEnabled disabled={false} onConfig={onConfig} />);
    const trigger = screen.getByRole("button", { name: "模式" });
    expect(trigger).toHaveTextContent("计划");
    expect(trigger).toHaveTextContent("Swarm");
    fireEvent.click(trigger);
    expect(screen.getByRole("checkbox", { name: "计划" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Swarm" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "目标" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: null });
  });
});

describe("ModelMenu", () => {
  it("打开后当前模型选中高亮，选择其他模型触发 onSelectModel 并关闭", () => {
    const models: ModelProfile[] = [makeModelProfile(), makeModelProfile({ id: "claude-sonnet-4-6" })];
    const props = renderModelMenu({ selectableModels: models });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.getByRole("menuitemradio", { name: "claude-opus-4-8" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "claude-sonnet-4-6" }));
    expect(props.onSelectModel).toHaveBeenCalledWith(models[1]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("多供应商分组：其他组默认折叠，展开后可选", () => {
    const models: ModelProfile[] = [
      makeModelProfile(),
      makeModelProfile({ id: "gpt-5", provider: "openai" }),
    ];
    const props = renderModelMenu({ selectableModels: models });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.queryByRole("menuitemradio", { name: "gpt-5" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /openai/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5" }));
    expect(props.onSelectModel).toHaveBeenCalledWith(models[1]);
  });

  it("思考开关与「更多模型…」入口", () => {
    const props = renderModelMenu();
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "思考" }));
    expect(props.onSelectThinking).toHaveBeenCalledWith("mode:enabled");
    fireEvent.click(screen.getByRole("button", { name: "更多模型…" }));
    expect(props.onOpenModelSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("当前模型不在可用清单时顶部固定一条选中态", () => {
    renderModelMenu({ selectionUnavailable: true });
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.getByText("当前模型不在可用清单中")).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-4-8【anthropic】/)).toBeInTheDocument();
  });

  it("未声明 effort 的模型：滑块默认五档（不含 minimal/ultra）", async () => {
    // renderComposer 默认模型 IMAGE_CAPS 的 effort 为空 → 走 EFFORT_DEFAULT_ALL 回退（无 ultra）
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    const cells = container.querySelectorAll(".thinking-cell");
    // [默认, 低, 中, 高, 极高, max] = 6 个格子（5 档 effort + 左端点默认）
    expect(cells).toHaveLength(6);
    const labels = Array.from(cells).map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["默认", "低", "中", "高", "极高", "max"]);
    expect(screen.queryByRole("button", { name: "最低" })).not.toBeInTheDocument();
  });

  it("模型声明 effort [low, minimal]：滑块按强度顺序只显示 minimal/low 两档", async () => {
    stubApi([makeModelProfile({ capabilities: { thinking: [], effort: ["low", "minimal"], modalities: ["text"], imageOutput: false, tools: true } })]);
    const { container, client } = renderComposer();
    await waitModelsLoaded(client);
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    const cells = container.querySelectorAll(".thinking-cell");
    // 声明顺序 low→minimal 被打乱，滑块必须按规范序 [minimal, low]（左端点默认在前）
    expect(cells).toHaveLength(3);
    const labels = Array.from(cells).map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["默认", "最低", "低"]);
    expect(screen.queryByRole("button", { name: "中" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ultra" })).not.toBeInTheDocument();
  });
});

/**
 * /compact 发送链路：pending 期间防重复提交（压缩可能耗时，避免二次压缩/run 抢写账本）；
 * 无可压缩区段（compacted=false）时 toast 服务端返回的原因（changed 的提示由 WS 事件负责）。
 */

const compactSession = makeSession({
  id: "s1",
  title: "压缩提示作业",
  messages: [
    { id: "m1", role: "user", createdAt: "2026-08-11T00:00:00.000Z", content: [{ type: "text", text: "你好" }] },
  ],
});

setupStubWebSocket();

describe("/compact 发送反馈", () => {
  it("pending 期间重复提交被忽略；compacted=false 时 toast 原因", async () => {
    installAppFetchMock({ session: compactSession, models: [] });
    const inner = globalThis.fetch;
    let posts = 0;
    let release: (value: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/api/sessions/s1/messages")) {
        posts += 1;
        return gate;
      }
      return inner(input, init);
    });

    renderWithClient(<App />);
    const textarea = (await waitFor(() => {
      const element = document.getElementById("composer-input");
      expect(element).not.toBeNull();
      return element;
    })) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/compact" } });
    // 输入 "/" 前缀会打开命令补全弹层：第一次 Enter 选中补全项（填入 "/compact "），第二次才真正发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(posts).toBe(1));

    // 请求挂起期间再次 Enter：send.isPending 防重，不再发第二个 POST
    await act(async () => {});
    fireEvent.keyDown(textarea, { key: "Enter" });
    await act(async () => {});
    expect(posts).toBe(1);

    release(new Response(
      JSON.stringify({ accepted: true, compacted: false, result: { changed: false, mode: "overview", reason: "没有新的可压缩区段（保留最近 10 条消息）" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    expect(await screen.findByText(/没有新的可压缩区段/)).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it("compacted=true 时不重复 toast（由 context.compacted 事件负责）", async () => {
    installAppFetchMock({ session: compactSession, models: [] });
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.endsWith("/api/sessions/s1/messages")) {
        return new Response(JSON.stringify({ accepted: true, compacted: true, result: { changed: true, mode: "vault" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    });

    renderWithClient(<App />);
    const textarea = (await waitFor(() => {
      const element = document.getElementById("composer-input");
      expect(element).not.toBeNull();
      return element;
    })) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/compact" } });
    // 同上：第一次 Enter 选中补全项，第二次发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    // 等待请求完成（草稿被清空即 onSuccess 已执行）
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(screen.queryByText(/无需压缩|没有新的可压缩区段/)).not.toBeInTheDocument();
  });
});
