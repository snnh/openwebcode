import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MarkdownBlock } from "../components/MarkdownImpl";
import { highlightCode } from "../highlight";

// 高亮器打桩：断言语言传递即可，不加载 shiki 真语法
vi.mock("../highlight", () => ({
  // shouldHighlight 走真实阈值判定（超限降级为纯文本），只替换实际高亮调用
  shouldHighlight: () => true,
  highlightCode: vi.fn(async (code: string, lang?: string) =>
    lang ? `<code data-lang="${lang}">${code}</code>` : undefined),
}));

describe("Markdown 组件覆写", () => {
  it("围栏代码块语言透传到高亮器（修复 className 被 inline-code 覆盖的回归）", async () => {
    render(<MarkdownBlock>{"```ts\nconst x: number = 1\n```"}</MarkdownBlock>);
    await waitFor(() => expect(vi.mocked(highlightCode)).toHaveBeenCalled());
    expect(vi.mocked(highlightCode).mock.calls[0]![1]).toBe("ts");
  });

  it("行内代码不带语言、走 inline-code 样式", () => {
    const { container } = render(<MarkdownBlock>{"这是 `inline` 代码"}</MarkdownBlock>);
    const inline = container.querySelector("code.inline-code");
    expect(inline).toBeTruthy();
    expect(inline!.textContent).toBe("inline");
  });

  it("外部图片懒加载且不带 Referer", () => {
    const { container } = render(<MarkdownBlock>{"![alt](https://example.com/x.png)"}</MarkdownBlock>);
    const img = container.querySelector("img");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("src")).toBe("https://example.com/x.png");
  });

  it("javascript: 协议链接被剥离（react-markdown 默认 urlTransform）", () => {
    const { container } = render(<MarkdownBlock>{"[x](javascript:alert(1))"}</MarkdownBlock>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
