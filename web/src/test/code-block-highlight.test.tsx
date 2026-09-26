import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "../components/CodeBlock";
import { HIGHLIGHT_MAX_CHARS, shouldHighlight } from "../highlight";
// shiki 主线程同步高亮成本护栏：超大内容必须降级为纯文本，否则打开大工具卡会卡住界面
vi.mock("../highlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../highlight")>();
  return { ...actual, highlightCode: vi.fn(async () => undefined) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("代码块高亮阈值", () => {
  it("阈值内高亮（小代码块走高亮路径），超阈值跳过高亮并给出说明，仍渲染文本且可复制", async () => {
    expect(shouldHighlight("const x = 1")).toBe(true); expect(shouldHighlight("a".repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
    const { highlightCode } = await import("../highlight");
    render(<CodeBlock lang="ts" code="const x: number = 1" />);
    await waitFor(() => expect(vi.mocked(highlightCode)).toHaveBeenCalledWith("const x: number = 1", "ts"));
    expect(screen.queryByText(/跳过高亮/)).not.toBeInTheDocument();
    cleanup(); vi.clearAllMocks();
    const huge = "const value = 1;\n".repeat(Math.ceil((HIGHLIGHT_MAX_CHARS + 10_000) / 17));
    expect(shouldHighlight(huge)).toBe(false);
    const { container } = render(<CodeBlock lang="ts" code={huge} />);
    expect(vi.mocked(highlightCode)).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/跳过高亮/)).toBeInTheDocument());
    expect(container.querySelector("code")).toHaveTextContent("const value = 1;");
    expect(screen.getByRole("button", { name: /复制/ })).toBeInTheDocument();
  });
});
