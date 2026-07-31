import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type PendingImage } from "../components/Composer";
import type { ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import { api } from "../lib/api";
import { readRecentModels, recordRecentModel } from "../lib/recent-models";
import { renderPdfToImages } from "../lib/pdf-to-images";

vi.mock("../lib/pdf-to-images", () => ({ renderPdfToImages: vi.fn() }));

// ComposerChips 走 react-query，本套件聚焦 Composer 本体，芯片由 composer-chips.test.tsx 覆盖
vi.mock("../components/ComposerChips", () => ({ ComposerChips: () => null }));

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

function Harness({ onSend, onConfig = () => {}, current = session, sendPending = false, initialDraft = "", initialAttachments = [], history = [], withSkills = skills, providers = [], models = [], supportsImages = true, pdfToImageExtension, pdfToImageStatus, imageCapabilitiesReady, onNotice = () => {} }: {
  onSend(): void;
  onConfig?(body: Record<string, unknown>): void;
  current?: SessionDetail;
  sendPending?: boolean;
  initialDraft?: string;
  initialAttachments?: PendingImage[];
  history?: string[];
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
      current={current}
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
      history={history}
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

/**
 * 路由式 fetch stub：@ 补全优先走索引端点（/api/workspaces/files、symbols），
 * 409/501 回退 complete-path。保持旧签名语义：status!==200 时索引端点也按该状态响应，
 * body.matches 自动映射为索引 files 响应，便于既有用例复用。
 */
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubCompletePath(body: unknown, status = 200): void {
  stubMentionApi({
    files: status === 200 && body && typeof body === "object" && "matches" in body
      ? { files: (body as { matches: Array<{ path: string }> }).matches.map((m) => ({ path: m.path, modifiedMs: 0 })), indexStatus: "fresh" }
      : body,
    filesStatus: status,
    fallback: body,
    fallbackStatus: status,
  });
}

function stubMentionApi(options: {
  files?: unknown;
  filesStatus?: number;
  symbols?: unknown;
  symbolsStatus?: number;
  fallback?: unknown;
  fallbackStatus?: number;
  onFetch?: (url: string) => void;
}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    options.onFetch?.(url);
    if (url.includes("/api/workspaces/files")) return respond(options.files ?? { files: [], indexStatus: "fresh" }, options.filesStatus ?? 200);
    if (url.includes("/api/workspaces/symbols")) return respond(options.symbols ?? { symbols: [], indexStatus: "fresh" }, options.symbolsStatus ?? 200);
    if (url.includes("/complete-path")) return respond(options.fallback ?? { matches: [] }, options.fallbackStatus ?? 200);
    return respond({}, 404);
  }));
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

  it("对话输入区位于横向会话配置之前", () => {
    const { textarea } = renderComposer({ onSend: vi.fn() });
    const mode = screen.getByLabelText("模式");
    expect(textarea.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
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

  it("mention 索引命中：符号条目显示 kind 与位置，选中插入 @路径:行号", async () => {
    stubMentionApi({
      files: { files: [{ path: "src/util.ts", modifiedMs: 0 }], indexStatus: "fresh" },
      symbols: { symbols: [{ name: "getTopSymbols", kind: "function", path: "src/util.ts", startLine: 3, endLine: 5, signature: "" }], indexStatus: "fresh" },
    });
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@util" } });
    expect(await screen.findByText("getTopSymbols")).toBeInTheDocument();
    expect(screen.getByText("function")).toBeInTheDocument();
    expect(screen.getByText("src/util.ts:3")).toBeInTheDocument();
    // 文件在前、符号在后：移到符号条目后 Enter 选中
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.getAttribute("aria-activedescendant")).toBe("mention-option-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@src/util.ts:3 ");
  });

  it("mention 索引 409 时回退 complete-path 并给出状态提示", async () => {
    stubMentionApi({
      files: { error: "Symbol index has not been built", code: "INDEX_UNAVAILABLE" },
      filesStatus: 409,
      fallback: { matches: [{ path: "src/live.ts" }] },
    });
    const { textarea } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@live" } });
    expect(await screen.findByText("src/live.ts")).toBeInTheDocument();
    expect(screen.getByText(/索引未建或不可用/)).toBeInTheDocument();
  });

  it("mention 索引滞后时提示结果可能不是最新", async () => {
    stubMentionApi({
      files: { files: [{ path: "src/stale.ts", modifiedMs: 0 }], indexStatus: "stale" },
    });
    const { textarea } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "@stale" } });
    expect(await screen.findByText("src/stale.ts")).toBeInTheDocument();
    expect(screen.getByText(/索引滞后/)).toBeInTheDocument();
  });

  it("mention 防抖：快速连续输入只发最后一次索引请求", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      stubMentionApi({ onFetch: (url) => calls.push(url) });
      const { textarea } = renderComposer({ onSend: vi.fn() });
      fireEvent.change(textarea, { target: { value: "@a" } });
      fireEvent.change(textarea, { target: { value: "@ab" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      const fileCalls = calls.filter((url) => url.includes("/api/workspaces/files"));
      expect(fileCalls).toHaveLength(1);
      expect(fileCalls[0]).toContain("q=ab");
    } finally {
      vi.useRealTimers();
    }
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

    fireEvent.change(textarea, { target: { value: "/in" } });
    const initOption = screen.getByRole("option", { name: /\/init/ });
    expect(initOption).toHaveTextContent("内置");
    expect(initOption).toHaveTextContent("AGENTS.md");
  });

  it("技能补全无匹配时 Enter 关闭弹层而不发送", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "/zzz" } });
    expect(screen.getByRole("listbox", { name: "技能建议" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "技能建议" })).not.toBeInTheDocument();
  });

  it("模型弹层选择模型同时切换 provider 与模型", () => {
    const onConfig = vi.fn();
    const models: ModelProfile[] = [{
      id: "gpt-4o-mini",
      provider: "openai",
      contextWindow: 128_000,
      maxOutput: 16_384,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }];
    render(<Harness onSend={vi.fn()} onConfig={onConfig} providers={["openai"]} models={models} />);
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /gpt-4o-mini/ }));
    expect(onConfig).toHaveBeenCalledWith({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("切换模型：目标已声明且不兼容时同请求清除思考设置，未声明时保留", () => {
    const onConfig = vi.fn();
    const models: ModelProfile[] = [{
      id: "claude-opus-4-8",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: { thinking: ["adaptive"], effort: ["xhigh"], modalities: ["text"], imageOutput: false, tools: true },
    }, {
      id: "claude-haiku-4-5",
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutput: 64_000,
      capabilities: { thinking: ["adaptive"], effort: ["low"], modalities: ["text"], imageOutput: false, tools: true },
    }, {
      id: "gpt-4o-mini",
      provider: "openai",
      contextWindow: 128_000,
      maxOutput: 16_384,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }];
    render(
      <Harness
        onSend={vi.fn()}
        onConfig={onConfig}
        current={{ ...session, thinking: "adaptive", effort: "xhigh" }}
        providers={["anthropic", "openai"]}
        models={models}
      />,
    );

    // 已声明（effort 只有 low，不含 xhigh）：同请求清除不兼容的 effort，thinking 兼容保留
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /claude-haiku-4-5/ }));
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "anthropic", model: "claude-haiku-4-5", effort: null });

    // 未声明（capabilities 空）：继承的 thinking/effort 全部保留，不再清除
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    // openai 组默认收起，先展开分组
    fireEvent.click(screen.getByRole("button", { name: /openai/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /gpt-4o-mini/ }));
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("模型按供应商分组：异供应商组默认收起，点击组头展开；模型行不再显示供应商小字", () => {
    const models: ModelProfile[] = [{
      id: "claude-opus-4-8",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }, {
      id: "gpt-4o-mini",
      provider: "openai",
      contextWindow: 128_000,
      maxOutput: 16_384,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }];
    render(<Harness onSend={vi.fn()} providers={["anthropic", "openai"]} models={models} />);
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    // anthropic 组（含当前模型）默认展开；openai 组收起：模型不可见，组头可见且带计数
    expect(screen.getByRole("menuitemradio", { name: /claude-opus-4-8/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: /gpt-4o-mini/ })).not.toBeInTheDocument();
    const header = screen.getByRole("button", { name: /openai/ });
    expect(header).toHaveTextContent("1");
    fireEvent.click(header);
    const item = screen.getByRole("menuitemradio", { name: /gpt-4o-mini/ });
    expect(item).toBeInTheDocument();
    expect(item).not.toHaveTextContent("openai");
  });

  it("思考合并在模型弹层底部固定区：胶囊开关 + 程度滑块（默认/低/高/极高）", () => {
    const onConfig = vi.fn();
    const models: ModelProfile[] = [{
      id: "claude-opus-4-8",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: {
        thinking: ["adaptive", "disabled"],
        effort: ["low", "high", "xhigh"],
        modalities: ["text", "image"],
        imageOutput: false,
        tools: true,
      },
    }];
    render(
      <Harness
        onSend={vi.fn()}
        onConfig={onConfig}
        current={{ ...session, thinking: "disabled", effort: "high" }}
        providers={["anthropic"]}
        models={models}
      />,
    );

    const trigger = screen.getByRole("button", { name: "模型与思考程度" });
    expect(trigger.closest(".composer-toolbar")).not.toBeNull();
    // 有 effort 即视为开：chip 显示当前档位
    expect(trigger).toHaveTextContent("高");

    fireEvent.click(trigger);
    // 缓存失效提示已移除
    expect(screen.queryByText(/提示：切换模型或思考程度/)).not.toBeInTheDocument();
    // 胶囊开关开（effort=high 视为开）；格子强度条当前档为「高」（档位=默认+low/high/xhigh 共 4 格）
    const toggle = screen.getByRole("checkbox", { name: "思考" });
    expect(toggle).toBeChecked();
    const cells = screen.getByRole("group", { name: "思考程度" });
    expect(cells).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("更快")).toBeInTheDocument();
    expect(screen.getByText("更聪明")).toBeInTheDocument();
    // 只显示当前档位文本：右端显示「高」，其余档位无可见文本（格子仅 aria-label）
    const current = document.querySelector(".thinking-slider-current");
    expect(current).toHaveTextContent("高");

    // 点最右格「极高」：写入 effort:xhigh（thinking 自动补齐 adaptive）
    fireEvent.click(screen.getByRole("button", { name: "极高" }));
    expect(onConfig).toHaveBeenLastCalledWith({ thinking: "adaptive", effort: "xhigh" });
    // 点首格「默认」：thinking=adaptive、不带 effort
    fireEvent.click(screen.getByRole("button", { name: "默认" }));
    expect(onConfig).toHaveBeenLastCalledWith({ thinking: "adaptive", effort: null });
    // 胶囊开关关：双 null
    fireEvent.click(toggle);
    expect(onConfig).toHaveBeenLastCalledWith({ thinking: null, effort: null });
  });

  it("未声明思考能力的模型：滑块给全部档位（默认 低 中 高 极高 max ultra），开关默认关", () => {
    const onConfig = vi.fn();
    const models: ModelProfile[] = [{
      id: "qwen3.8-max-preview",
      provider: "zijian",
      contextWindow: 1_000_000,
      maxOutput: 16_384,
      capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
    }];
    render(
      <Harness
        onSend={vi.fn()}
        onConfig={onConfig}
        current={{ ...session, provider: "zijian", model: "qwen3.8-max-preview" }}
        providers={["zijian"]}
        models={models}
      />,
    );
    const trigger = screen.getByRole("button", { name: "模型与思考程度" });
    // 开关默认关：chip 徽标「关」
    expect(trigger).toHaveTextContent("关");
    fireEvent.click(trigger);
    const toggle = screen.getByRole("checkbox", { name: "思考" });
    expect(toggle).not.toBeChecked();
    // 未声明：格子 = 默认 + 全部六档，max/ultra 均在（格子只有 aria-label，无可见文本）
    for (const label of ["默认", "低", "中", "高", "极高", "max", "ultra"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // 开关打开（无 effort 时走 mode:enabled，未声明模型服务端放行）
    fireEvent.click(toggle);
    expect(onConfig).toHaveBeenLastCalledWith({ thinking: "enabled", effort: null });
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

    expect(screen.queryByText("图片输入")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模型与思考程度" }));
    expect(screen.getByText("图片输入")).toBeInTheDocument();
    expect(screen.getByText("视频输入")).toBeInTheDocument();
    expect(screen.getByText("图片输出")).toBeInTheDocument();
  });

  it("权限弹层：四档选项带描述，选择写入 permissionMode", () => {
    const onConfig = vi.fn();
    render(<Harness onSend={vi.fn()} onConfig={onConfig} />);
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    // 四档：逐次确认（默认勾选）/ 接受编辑 / 模型审核 / 完全自主，均带描述
    expect(screen.getByRole("menuitemradio", { name: /逐次确认/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^接受编辑/ })).toBeInTheDocument();
    const review = screen.getByRole("menuitemradio", { name: /模型审核/ });
    expect(review).toHaveTextContent("低风险操作由快速模型自动通过");
    const yolo = screen.getByRole("menuitemradio", { name: /完全自主/ });
    expect(yolo).toHaveTextContent("不再询问");
    fireEvent.click(review);
    expect(onConfig).toHaveBeenCalledWith({ permissionMode: "review" });
    // 选中后弹层关闭，重新打开再选完全自主
    fireEvent.click(screen.getByRole("button", { name: "权限模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /完全自主/ }));
    expect(onConfig).toHaveBeenCalledWith({ permissionMode: "yolo" });
  });

  it("模式弹层：Swarm 开关写入会话配置，计划/目标开关切换互斥的 agentMode", () => {
    const onConfig = vi.fn();
    render(<Harness onSend={vi.fn()} onConfig={onConfig} />);
    fireEvent.click(screen.getByRole("button", { name: "模式" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Swarm" }));
    expect(onConfig).toHaveBeenCalledWith({ swarmEnabled: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "plan" });
    // 目标开关已启用：不再禁用、无「即将推出」标记，勾选写入 agentMode: "goal"
    const goal = screen.getByRole("checkbox", { name: "目标" });
    expect(goal).toBeEnabled();
    expect(screen.queryByText("即将推出")).not.toBeInTheDocument();
    fireEvent.click(goal);
    expect(onConfig).toHaveBeenCalledWith({ agentMode: "goal" });
  });

  it("模式弹层：agentMode 为 goal 时目标开关开、计划开关关（后端单值存储天然互斥）", () => {
    render(<Harness onSend={vi.fn()} current={{ ...session, agentMode: "goal" }} />);
    fireEvent.click(screen.getByRole("button", { name: "模式" }));
    expect(screen.getByRole("checkbox", { name: "目标" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "计划" })).not.toBeChecked();
    // 触发按钮徽标展示当前模式
    expect(screen.getByRole("button", { name: "模式" })).toHaveTextContent("目标");
  });

  it("模式弹层：Swarm 可与任一模式叠加（plan + swarm 组合写入互不干扰）", () => {
    const onConfig = vi.fn();
    render(<Harness onSend={vi.fn()} onConfig={onConfig} current={{ ...session, agentMode: "plan", swarmEnabled: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "模式" }));
    // plan 与 Swarm 同时勾选共存；触发徽标并列展示
    expect(screen.getByRole("checkbox", { name: "计划" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Swarm" })).toBeChecked();
    expect(screen.getByRole("button", { name: "模式" })).toHaveTextContent("计划 · Swarm");
    // 关闭 Swarm 只写 swarmEnabled，不动 agentMode
    fireEvent.click(screen.getByRole("checkbox", { name: "Swarm" }));
    expect(onConfig).toHaveBeenLastCalledWith({ swarmEnabled: false });
    // 关闭计划只写 agentMode，不动 swarmEnabled
    fireEvent.click(screen.getByRole("checkbox", { name: "计划" }));
    expect(onConfig).toHaveBeenLastCalledWith({ agentMode: null });
  });
});

describe("Composer 输入历史回查", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  const history = ["最新一条", "中间一条", "最早一条"];

  it("↑ 逐条回退历史，回到底后 ↓ 恢复进入时暂存的草稿", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), initialDraft: "未发送草稿", history });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最新一条");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("中间一条");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最早一条");
    // 到顶后继续 ↑ 保持最旧一条
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最早一条");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("中间一条");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("最新一条");
    // ↓ 越过最新一条：退出回查并恢复暂存草稿
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("未发送草稿");
  });

  it("多行草稿光标不在首行时 ↑ 不触发回查，移到首行后触发", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), initialDraft: "第一行\n第二行", history });
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("第一行\n第二行");
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最新一条");
  });

  it("技能补全弹层打开时 ↑ 由弹层消费，不触发历史回查", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), initialDraft: "/r", history });
    expect(screen.getByRole("listbox", { name: "技能建议" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("/r");
  });

  it("回查中用户编辑即退出回查，再次 ↑ 重新暂存当前文本", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), history });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最新一条");
    fireEvent.change(textarea, { target: { value: "改过的文本" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最新一条");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("改过的文本");
  });

  it("历史为空时 ↑ 不改变草稿", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), initialDraft: "保持原样" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("保持原样");
  });

  it("输入法组合中（isComposing）↑/↓ 不触发历史回查", () => {
    const { textarea } = renderComposer({ onSend: vi.fn(), history });
    // 组合中 ↑：IME 用于移动候选，不得回查历史
    fireEvent.keyDown(textarea, { key: "ArrowUp", isComposing: true });
    expect(textarea.value).toBe("");
    // 先正常回查一条，组合中 ↓ 不得前进/退出回查
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("最新一条");
    fireEvent.keyDown(textarea, { key: "ArrowDown", isComposing: true });
    expect(textarea.value).toBe("最新一条");
  });
});

describe("Composer 模型循环（Ctrl+P）", () => {
  const cycleModels: ModelProfile[] = [{
    id: "claude-opus-4-8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
  }, {
    id: "gpt-4o-mini",
    provider: "openai",
    contextWindow: 128_000,
    maxOutput: 16_384,
    capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
  }, {
    id: "deepseek-v3",
    provider: "deepseek",
    contextWindow: 64_000,
    maxOutput: 8_192,
    capabilities: { thinking: [], effort: [], modalities: ["text"], imageOutput: false, tools: true },
  }];
  const cycleProviders = ["anthropic", "openai", "deepseek"];

  function seedRecent(entries: Array<{ provider: string; model: string }>): void {
    localStorage.setItem("owc-recent-models", JSON.stringify(entries));
  }

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("弹层切换模型写入 localStorage：去重置前", () => {
    render(<Harness onSend={vi.fn()} onConfig={vi.fn()} providers={cycleProviders} models={cycleModels} />);
    const trigger = screen.getByRole("button", { name: "模型与思考程度" });
    const pick = (name: RegExp): void => {
      fireEvent.click(trigger);
      // 非当前供应商的分组默认收起：先展开全部组再点模型（折叠状态跨开合保留，只需展开一次）
      for (const header of screen.queryAllByRole("button", { name: /^(anthropic|openai|deepseek)/ })) {
        if (header.getAttribute("aria-expanded") === "false") fireEvent.click(header);
      }
      fireEvent.click(screen.getByRole("menuitemradio", { name }));
    };
    pick(/gpt-4o-mini/);
    pick(/deepseek-v3/);
    pick(/gpt-4o-mini/);
    expect(JSON.parse(localStorage.getItem("owc-recent-models")!)).toEqual([
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "deepseek", model: "deepseek-v3" },
    ]);
  });

  it("最近列表上限 5 条，最早记录被截断", () => {
    for (let index = 0; index < 6; index += 1) {
      recordRecentModel("p", `m${index}`);
    }
    expect(readRecentModels()).toEqual([
      { provider: "p", model: "m5" },
      { provider: "p", model: "m4" },
      { provider: "p", model: "m3" },
      { provider: "p", model: "m2" },
      { provider: "p", model: "m1" },
    ]);
  });

  it("Ctrl+P 按最近列表顺序循环，调用 onConfig 并给出提示", () => {
    seedRecent([
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "deepseek", model: "deepseek-v3" },
    ]);
    const onConfig = vi.fn();
    const { textarea } = renderComposer({ onSend: vi.fn(), onConfig, providers: cycleProviders, models: cycleModels });

    // 当前模型是列表首条 → 切到第二条（按键被拦截，浏览器默认被阻止）
    expect(fireEvent.keyDown(textarea, { key: "p", ctrlKey: true })).toBe(false);
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "openai", model: "gpt-4o-mini" });
    // 配置生效前连续按：基于上次循环目标继续前进
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "deepseek", model: "deepseek-v3" });
    // 到底后回到顶部
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(screen.getByRole("status")).toHaveTextContent("已切换模型");
  });

  it("当前模型不在最近列表时从最新一条开始", () => {
    seedRecent([
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "deepseek", model: "deepseek-v3" },
    ]);
    const onConfig = vi.fn();
    const { textarea } = renderComposer({ onSend: vi.fn(), onConfig, providers: cycleProviders, models: cycleModels });
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });
    expect(onConfig).toHaveBeenLastCalledWith({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("最近列表不足 2 条时 Ctrl+P 为 no-op，不拦截浏览器默认行为", () => {
    seedRecent([{ provider: "anthropic", model: "claude-opus-4-8" }]);
    const onConfig = vi.fn();
    const { textarea } = renderComposer({ onSend: vi.fn(), onConfig });
    // fireEvent 返回 true 表示未调用 preventDefault
    expect(fireEvent.keyDown(textarea, { key: "p", ctrlKey: true })).toBe(true);
    expect(onConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("输入法组合中（isComposing）忽略 Ctrl+P", () => {
    seedRecent([
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "openai", model: "gpt-4o-mini" },
    ]);
    const onConfig = vi.fn();
    const { textarea } = renderComposer({ onSend: vi.fn(), onConfig });
    expect(fireEvent.keyDown(textarea, { key: "p", ctrlKey: true, isComposing: true })).toBe(true);
    expect(onConfig).not.toHaveBeenCalled();
  });
});


describe("PDF 提示关闭", () => {
  beforeEach(() => {
    window.localStorage.removeItem("owc.pdf-hint-dismissed");
  });
  afterEach(() => {
    window.localStorage.removeItem("owc.pdf-hint-dismissed");
  });

  it("点击关闭按钮后提示不再渲染，签名写入 localStorage", () => {
    render(<Harness onSend={vi.fn()} pdfToImageExtension={{ enabled: false, config: {} }} />);
    expect(document.querySelector(".composer-hint")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));

    expect(document.querySelector(".composer-hint")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("owc.pdf-hint-dismissed")).toBe("ready.disabled");
  });

  it("扩展状态变化后签名不同，提示重新出现", () => {
    window.localStorage.setItem("owc.pdf-hint-dismissed", "unavailable.disabled");
    render(<Harness onSend={vi.fn()} pdfToImageExtension={{ enabled: false, config: {} }} />);
    // 当前签名 ready.disabled ≠ 已关闭签名 → 提示仍然显示
    expect(document.querySelector(".composer-hint")).toBeInTheDocument();
  });

  it("同一签名已关闭时提示不渲染", () => {
    window.localStorage.setItem("owc.pdf-hint-dismissed", "ready.disabled");
    render(<Harness onSend={vi.fn()} pdfToImageExtension={{ enabled: false, config: {} }} />);
    expect(document.querySelector(".composer-hint")).not.toBeInTheDocument();
  });
});
