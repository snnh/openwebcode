import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MarkdownBlock } from "../components/MarkdownImpl";
import { highlightCode } from "../highlight";
// 高亮器打桩：断言语言透传与安全默认，不加载 shiki 真语法
vi.mock("../highlight", () => ({
  shouldHighlight: () => true,
  highlightCode: vi.fn(async (code: string, lang?: string) => (lang ? `<code data-lang="${lang}">${code}</code>` : undefined)),
}));
describe("Markdown 组件覆写", () => {
  it("围栏代码块把语言透传给高亮器；行内代码、外部图片与危险协议链接按安全默认处理", async () => {
    render(<MarkdownBlock>{"```ts\nconst x: number = 1\n```"}</MarkdownBlock>); await waitFor(() => expect(vi.mocked(highlightCode)).toHaveBeenCalled());
    expect(vi.mocked(highlightCode).mock.calls[0]![1]).toBe("ts");
    const { container } = render(<MarkdownBlock>{"`inline` 与 ![alt](https://example.com/x.png) 与 [x](javascript:alert(1))"}</MarkdownBlock>);
    expect(container.querySelector("code")!.textContent).toBe("inline"); const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy"); expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("a")!.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
