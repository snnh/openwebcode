import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type PendingImage } from "../components/Composer";
import type { ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import { api } from "../lib/api";
import { renderPdfToImages } from "../lib/pdf-to-images";

vi.mock("../lib/pdf-to-images", () => ({ renderPdfToImages: vi.fn() }));

const renderPdfToImagesMock = vi.mocked(renderPdfToImages);
const uploadPdfMock = vi.spyOn(api, "uploadPdf");

const session: SessionDetail = {
  id: "s1",
  cwd: "/workspace/project",
  provider: "anthropic",
  model: "claude-opus-4-8",
  title: "测试作业",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
  messages: [],
};

const secondSession: SessionDetail = {
  ...session,
  id: "s2",
  cwd: "/workspace/second-project",
  title: "第二个作业",
};

const skills: SkillInfo[] = [
  { name: "review", description: "代码审查", source: "project" },
  { name: "run", description: "运行", source: "global" },
];

function Harness({ onSend, onConfig = () => {}, sendPending = false, initialDraft = "", initialAttachments = [], withSkills = skills, providers = [], models = [], supportsImages = true, pdfToImageExtension, pdfToImageStatus, imageCapabilitiesReady, onNotice = () => {} }: {
  onSend(): void;
  onConfig?(body: Record<string, unknown>): void;
  sendPending?: boolean;
  initialDraft?: string;
  initialAttachments?: PendingImage[];
  withSkills?: SkillInfo[];
  providers?: string[];
  models?: ModelProfile[];
  supportsImages?: boolean;
  pdfToImageExtension?: { enabled: boolean; config: Record<string, unknown> };
  pdfToImageStatus?: "loading" | "ready" | "unavailable";
  imageCapabilitiesReady?: boolean;
  onNotice?(message: string): void;
}): ReturnType<typeof Composer> {
  const [draft, setDraft] = useState(initialDraft);
  const [attachments, setAttachments] = useState<PendingImage[]>(initialAttachments);
  return (
    <Composer
      current={session}
      models={models}
      providers={providers}
      pdfToImageExtension={pdfToImageExtension}
      pdfToImageStatus={pdfToImageStatus}
      imageCapabilitiesReady={imageCapabilitiesReady}
      draft={draft}
      setDraft={setDraft}
      onSend={onSend}
      onConfig={onConfig}
      running={false}
      sendKey="enter"
      skills={withSkills}
      attachments={attachments}
      setAttachments={setAttachments}
      supportsImages={supportsImages}
      sendPending={sendPending}
      onNotice={onNotice}
    />
  );
}

function SessionSwitchHarness({ onNotice = () => {} }: { onNotice?(message: string, kind?: "info" | "error"): void }): ReturnType<typeof Composer> {
  const [current, setCurrent] = useState(session);
  const [drafts, setDrafts] = useState<Record<string, string>>({ s1: "A 草稿", s2: "B 草稿" });
  const [attachments, setAttachments] = useState<PendingImage[]>([]);
  return (
    <>
      <button type="button" onClick={() => setCurrent(secondSession)}>切换会话</button>
      <Composer
        current={current}
        models={[]}
        pdfToImageExtension={{ enabled: true, config: {} }}
        draft={drafts[current.id] ?? ""}
        setDraft={(value) => setDrafts((previous) => ({ ...previous, [current.id]: value }))}
        onSend={() => {}}
        onConfig={() => {}}
        running={false}
        sendKey="enter"
        skills={skills}
        attachments={attachments}
        setAttachments={setAttachments}
        supportsImages
        onNotice={onNotice}
      />
    </>
  );
}

function renderComposer(options: Parameters<typeof Harness>[0]): { textarea: HTMLTextAreaElement; onSend: ReturnType<typeof vi.fn> } {
  const onSend = options.onSend as ReturnType<typeof vi.fn>;
  render(<Harness {...options} onSend={onSend} />);
  return { textarea: screen.getByRole("combobox", { name: /消息输入框/ }) as HTMLTextAreaElement, onSend };
}

function stubCompletePath(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

describe("Composer", () => {
  beforeEach(() => {
    // jsdom 未实现 scrollIntoView，弹层激活项滚动依赖它
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    renderPdfToImagesMock.mockReset();
    uploadPdfMock.mockReset();
  });

  it("粘贴图片+文本的混合内容时文本插入光标处而非丢弃", () => {
    const { textarea } = renderComposer({ onSend: vi.fn() });
    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [file],
        getData: (type: string) => (type === "text" ? "截图说明" : ""),
      },
    });
    expect(textarea.value).toBe("截图说明");
  });

  it("拖入 PDF 时按剩余附件数转换、展示进度并在转换期间阻止发送", async () => {
    let finishUpload!: (value: { path: string }) => void;
    uploadPdfMock.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    let finishRender!: (value: Awaited<ReturnType<typeof renderPdfToImages>>) => void;
    renderPdfToImagesMock.mockImplementation((_file, options, onProgress) => new Promise((resolve) => {
      expect(options).toEqual({ maxPages: 2, dpi: 300, maxDimension: 2048 });
      onProgress?.({ completed: 1, total: 2 });
      finishRender = resolve;
    }));
    const onNotice = vi.fn();
    const initialAttachments: PendingImage[] = [
      { mediaType: "image/png", data: "existing-1", previewUrl: "data:image/png;base64,existing-1" },
      { mediaType: "image/png", data: "existing-2", previewUrl: "data:image/png;base64,existing-2" },
    ];
    const { textarea, onSend } = renderComposer({
      onSend: vi.fn(),
      initialDraft: "请分析",
      initialAttachments,
      onNotice,
      pdfToImageExtension: { enabled: true, config: { maxPages: 9, dpi: 900, maxDimension: 9_000 } },
    });
    const pdf = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });

    fireEvent.drop(textarea.closest("footer")!, { dataTransfer: { files: [pdf] } });

    await waitFor(() => expect(uploadPdfMock).toHaveBeenCalledWith("s1", pdf));
    expect(screen.getByRole("status")).toHaveTextContent("正在保存 PDF");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(renderPdfToImagesMock).not.toHaveBeenCalled();

    await act(async () => {
      finishUpload({ path: ".owc/uploads/report.pdf" });
    });
    await waitFor(() => expect(renderPdfToImagesMock).toHaveBeenCalledWith(pdf, { maxPages: 2, dpi: 300, maxDimension: 2048 }, expect.any(Function)));
    expect(screen.getByRole("status")).toHaveTextContent("1/2");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      finishRender({
        images: [
          { mediaType: "image/png", data: "page-1", previewUrl: "data:image/png;base64,page-1" },
          { mediaType: "image/png", data: "page-2", previewUrl: "data:image/png;base64,page-2" },
        ],
        totalPages: 6,
        truncated: true,
      });
    });

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getAllByRole("img", { name: /附件/ })).toHaveLength(4);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/仅转换前 2\/6 页/), "info");
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("关闭 PDF 扩展时先保存到工作区，仅插入服务端返回的路径且不调用渲染器", async () => {
    const onNotice = vi.fn();
    render(<Harness onSend={vi.fn()} initialDraft="请查看" supportsImages={false} pdfToImageExtension={{ enabled: false, config: {} }} onNotice={onNotice} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const pdf = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
    let finishUpload!: (value: { path: string }) => void;
    uploadPdfMock.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));

    fireEvent.change(input, { target: { files: [pdf] } });

    await waitFor(() => expect(uploadPdfMock).toHaveBeenCalledWith("s1", pdf));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await act(async () => {
      finishUpload({ path: ".owc/uploads/report.pdf" });
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: /消息输入框/ })).toHaveValue("请查看 [PDF path: .owc/uploads/report.pdf]"));
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/已保存到工作区/), "info");
    expect(renderPdfToImagesMock).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("PDF 渲染失败时保留草稿、插入路径引用并给出可理解的错误", async () => {
    uploadPdfMock.mockResolvedValue({ path: ".owc/uploads/broken.pdf" });
    renderPdfToImagesMock.mockRejectedValue(new Error("invalid PDF"));
    const onNotice = vi.fn();
    const { textarea } = renderComposer({ onSend: vi.fn(), initialDraft: "请分析", onNotice, pdfToImageExtension: { enabled: true, config: {} } });
    const pdf = new File(["bad"], "broken.pdf", { type: "application/pdf" });

    fireEvent.paste(textarea, { clipboardData: { files: [pdf], getData: () => "" } });

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/PDF.*转换失败.*invalid PDF/), "error"));
    expect(textarea.value).toBe("请分析 [PDF path: .owc/uploads/broken.pdf]");
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("模型不支持图片或图片槽位耗尽时仍插入已保存 PDF 的路径", async () => {
    uploadPdfMock.mockResolvedValue({ path: ".owc/uploads/fallback.pdf" });
    const onNotice = vi.fn();
    const { textarea } = renderComposer({
      onSend: vi.fn(),
      initialDraft: "请分析",
      initialAttachments: Array.from({ length: 4 }, (_, index) => ({ mediaType: "image/png", data: `existing-${index}`, previewUrl: `data:image/png;base64,existing-${index}` })),
      onNotice,
      pdfToImageExtension: { enabled: true, config: {} },
    });
    const pdf = new File(["%PDF-1.7"], "fallback.pdf", { type: "application/pdf" });

    fireEvent.drop(textarea.closest("footer")!, { dataTransfer: { files: [pdf] } });

    await waitFor(() => expect(textarea).toHaveValue("请分析 [PDF path: .owc/uploads/fallback.pdf]"));
    expect(renderPdfToImagesMock).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/路径引用/), "info");
  });

  it("会话切换后丢弃旧 PDF 渲染结果，不污染新会话附件或处理状态", async () => {
    uploadPdfMock.mockResolvedValue({ path: ".owc/uploads/from-session-a.pdf" });
    let finishRender!: (value: Awaited<ReturnType<typeof renderPdfToImages>>) => void;
    renderPdfToImagesMock.mockImplementation(() => new Promise((resolve) => { finishRender = resolve; }));
    render(<SessionSwitchHarness />);
    const pdf = new File(["%PDF-1.7"], "from-session-a.pdf", { type: "application/pdf" });

    fireEvent.drop(screen.getByRole("combobox", { name: /消息输入框/ }).closest("footer")!, { dataTransfer: { files: [pdf] } });
    await waitFor(() => expect(renderPdfToImagesMock).toHaveBeenCalledWith(pdf, expect.any(Object), expect.any(Function)));
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换会话" }));
    expect(screen.getByRole("combobox", { name: /消息输入框/ })).toHaveValue("B 草稿");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();

    await act(async () => {
      finishRender({
        images: [{ mediaType: "image/png", data: "from-a", previewUrl: "data:image/png;base64,from-a" }],
        totalPages: 1,
        truncated: false,
      });
    });

    expect(screen.getByRole("combobox", { name: /消息输入框/ })).toHaveValue("B 草稿");
    expect(screen.queryAllByRole("img", { name: /附件/ })).toHaveLength(0);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("会话切换后丢弃旧 PDF 上传响应，不向新会话插入路径或启动渲染", async () => {
    let finishUpload!: (value: { path: string }) => void;
    uploadPdfMock.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    render(<SessionSwitchHarness />);
    const pdf = new File(["%PDF-1.7"], "uploading-in-a.pdf", { type: "application/pdf" });

    fireEvent.drop(screen.getByRole("combobox", { name: /消息输入框/ }).closest("footer")!, { dataTransfer: { files: [pdf] } });
    await waitFor(() => expect(uploadPdfMock).toHaveBeenCalledWith("s1", pdf));
    fireEvent.click(screen.getByRole("button", { name: "切换会话" }));

    await act(async () => {
      finishUpload({ path: ".owc/uploads/uploading-in-a.pdf" });
    });

    expect(screen.getByRole("combobox", { name: /消息输入框/ })).toHaveValue("B 草稿");
    expect(renderPdfToImagesMock).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("img", { name: /附件/ })).toHaveLength(0);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("PDF 扩展或图片能力仍在加载时不上传 PDF", async () => {
    const onNotice = vi.fn();
    render(<Harness onSend={vi.fn()} pdfToImageStatus="loading" onNotice={onNotice} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const pdf = new File(["%PDF-1.7"], "wait.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [pdf] } });

    expect(uploadPdfMock).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/读取 PDF 扩展状态/), "error");
  });

  it("sendPending 时发送按钮禁用且 Enter 不触发发送", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn(), sendPending: true, initialDraft: "hello" });
    expect(screen.getByRole("button", { name: /发送/ })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("非 pending 时 Enter 正常发送", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn(), initialDraft: "hello" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("mention 匹配加载间隙按 Enter 不发送、仅关闭补全", () => {
    stubCompletePath({ matches: [{ path: "src/a.ts" }] });
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@src" } });
    // 防抖 200ms 未到、matches 为空，弹层处于打开态
    expect(screen.getByRole("listbox", { name: "文件引用建议" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "文件引用建议" })).not.toBeInTheDocument();
  });

  it("mention API 失败时提示与「无匹配文件」区分", async () => {
    stubCompletePath({ error: "boom" }, 500);
    const { textarea } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@src" } });
    expect(await screen.findByText(/文件列表加载失败/)).toBeInTheDocument();
  });

  it("mention 有匹配时方向键更新 aria-activedescendant，Enter 选中", async () => {
    stubCompletePath({ matches: [{ path: "src/a.ts" }, { path: "src/b.ts" }] });
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@src" } });
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(textarea.getAttribute("aria-controls")).toBe("mention-listbox");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-activedescendant")).toBe("mention-option-0");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.getAttribute("aria-activedescendant")).toBe("mention-option-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@src/b.ts ");
  });

  it("技能补全弹层接线：combobox 语义、方向键与 Enter 选中", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.getAttribute("aria-controls")).toBeNull();
    fireEvent.change(textarea, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "技能建议" })).toBeInTheDocument();
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-controls")).toBe("skill-listbox");
    expect(textarea.getAttribute("aria-activedescendant")).toBe("skill-option-0");
    // 内置命令排在技能前：option-0=/clear、option-1=/compact、之后才是技能
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.getAttribute("aria-activedescendant")).toBe("skill-option-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/compact ");
  });

  it("内置命令参与斜杠补全并标记「内置」", () => {
    const { textarea } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "/cl" } });
    const option = screen.getByRole("option", { name: /\/clear/ });
    expect(option).toHaveTextContent("内置");
    expect(screen.queryByRole("option", { name: /\/compact/ })).not.toBeInTheDocument();
  });

  it("技能补全无匹配时 Enter 关闭弹层而不发送", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "/zzz" } });
    expect(screen.getByRole("listbox", { name: "技能建议" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "技能建议" })).not.toBeInTheDocument();
  });

  it("单一模型选择器同时切换 provider 与模型", () => {
    const onConfig = vi.fn();
    const models: ModelProfile[] = [{
      id: "gpt-4o-mini",
      provider: "openai",
      contextWindow: 128_000,
      maxOutput: 16_384,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }];
    render(<Harness onSend={vi.fn()} onConfig={onConfig} providers={["openai"]} models={models} />);
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: JSON.stringify(["openai", "gpt-4o-mini"]) } });
    expect(onConfig).toHaveBeenCalledWith({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("在模型选择器旁显示当前模型的图片、视频输入和图片输出能力", () => {
    const models: ModelProfile[] = [{
      id: "claude-opus-4-8",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: { thinking: [], effort: [], modalities: ["text", "image", "video"], imageOutput: true, tools: true },
    }];
    renderComposer({ onSend: vi.fn(), providers: ["anthropic"], models });

    expect(screen.getByText("图片输入")).toBeInTheDocument();
    expect(screen.getByText("视频输入")).toBeInTheDocument();
    expect(screen.getByText("图片输出")).toBeInTheDocument();
  });
});
