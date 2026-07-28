import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../components/CodeBlock";

// 高亮器走动态 import，测试中保持纯文本路径（复制按钮两种路径都应渲染）
vi.mock("../highlight", () => ({ highlightCode: vi.fn(async () => null) }));

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CodeBlock 复制按钮", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("渲染悬停复制按钮，点击后写入原始代码并显示「已复制」反馈", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const code = "const answer = 42;\nconsole.log(answer);";
    render(<CodeBlock lang="js" code={code} />);

    const button = screen.getByRole("button", { name: "复制代码" });
    expect(button.closest(".code-block-wrap")).not.toBeNull();
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("剪贴板写入失败时不显示已复制反馈", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    stubClipboard(writeText);
    // execCommand 降级同样失败
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<CodeBlock code="plain code" />);

    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("plain code"));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument();
    Reflect.deleteProperty(document, "execCommand");
  });
});
