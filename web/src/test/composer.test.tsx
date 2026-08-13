import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../composer/Composer";
import { clearComposerState } from "../composer/drafts";
import { qk } from "../app/queries";
import { setSendKey } from "../app/prefs-store";
import { ui } from "../app/ui-store";
import { api } from "../lib/api";
import type { ExtensionInfo, ModelProfile } from "../lib/contracts";
import type { ComposerProps } from "../chat/types";
import { makeModelProfile, makeSession } from "./helpers/fixtures";
import { makeTestClient } from "./helpers/with-client";

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
