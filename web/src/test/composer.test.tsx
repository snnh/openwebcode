import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type PendingImage } from "../components/Composer";
import type { SessionDetail, SkillInfo } from "../lib/contracts";

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

const skills: SkillInfo[] = [
  { name: "review", description: "代码审查", source: "project" },
  { name: "run", description: "运行", source: "global" },
];

function Harness({ onSend, sendPending = false, initialDraft = "", withSkills = skills }: {
  onSend(): void;
  sendPending?: boolean;
  initialDraft?: string;
  withSkills?: SkillInfo[];
}): ReturnType<typeof Composer> {
  const [draft, setDraft] = useState(initialDraft);
  const [attachments, setAttachments] = useState<PendingImage[]>([]);
  return (
    <Composer
      current={session}
      models={[]}
      draft={draft}
      setDraft={setDraft}
      onSend={onSend}
      onConfig={() => {}}
      running={false}
      sendKey="enter"
      skills={withSkills}
      attachments={attachments}
      setAttachments={setAttachments}
      supportsImages={true}
      sendPending={sendPending}
      onNotice={() => {}}
    />
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
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.getAttribute("aria-activedescendant")).toBe("skill-option-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/run ");
  });

  it("技能补全无匹配时 Enter 关闭弹层而不发送", () => {
    const { textarea, onSend } = renderComposer({ onSend: vi.fn() });
    fireEvent.change(textarea, { target: { value: "/zzz" } });
    expect(screen.getByRole("listbox", { name: "技能建议" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "技能建议" })).not.toBeInTheDocument();
  });
});
