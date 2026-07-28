import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { splitMarkdownBlocks } from "../components/markdown-split";
import { Markdown } from "../components/Markdown";

// 用渲染计数替身替换真实实现（懒加载链路不变），验证稳定块不随末尾块增长而重渲染
const renderCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("../components/MarkdownImpl", () => ({
  MarkdownBlock: ({ children }: { children: string }) => {
    renderCounts.set(children, (renderCounts.get(children) ?? 0) + 1);
    return <p data-testid="block">{children}</p>;
  },
}));

describe("splitMarkdownBlocks", () => {
  it("按空行切分段落", () => {
    expect(splitMarkdownBlocks("para1\n\npara2")).toEqual(["para1", "para2"]);
  });

  it("代码围栏内的空行不拆分", () => {
    const text = "before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual([
      "before",
      "```js\nconst a = 1;\n\nconst b = 2;\n```",
      "after",
    ]);
  });

  it("~~~ 围栏与更长的闭合围栏同样生效", () => {
    expect(splitMarkdownBlocks("~~~\na\n\nb\n~~~~\n\ntail")).toEqual(["~~~\na\n\nb\n~~~~", "tail"]);
  });

  it("围栏内的异种围栏标记视为内容", () => {
    expect(splitMarkdownBlocks("```\na\n~~~\n\nb\n```\n\ntail")).toEqual([
      "```\na\n~~~\n\nb\n```",
      "tail",
    ]);
  });

  it("未闭合围栏归入末尾块", () => {
    expect(splitMarkdownBlocks("para\n\n```js\ncode\n\nmore")).toEqual([
      "para",
      "```js\ncode\n\nmore",
    ]);
  });

  it("$$ 数学块内的空行不拆分", () => {
    const text = "text\n\n$$\na\n\nb\n$$\n\nafter";
    expect(splitMarkdownBlocks(text)).toEqual(["text", "$$\na\n\nb\n$$", "after"]);
  });

  it("单行 $$x$$ 不触发数学块状态", () => {
    expect(splitMarkdownBlocks("a $$x$$ b\n\nc")).toEqual(["a $$x$$ b", "c"]);
  });

  it("代码围栏内的 $$ 不触发数学块状态", () => {
    expect(splitMarkdownBlocks("```\n$$\n\n```\n\ntail")).toEqual(["```\n$$\n\n```", "tail"]);
  });

  it("CRLF 输入归一化后切分", () => {
    expect(splitMarkdownBlocks("para1\r\n\r\npara2")).toEqual(["para1", "para2"]);
  });

  it("空文本与纯空白文本返回空块列表", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("  \n\n \t ")).toEqual([]);
  });

  it("块用空行连接可还原输入", () => {
    const text = "# h1\n\n- a\n- b\n\n```\nx\n\ny\n```\n\n$$\nz\n$$";
    expect(splitMarkdownBlocks(text).join("\n\n")).toBe(text);
  });
});

describe("Markdown 分块增量渲染", () => {
  it("流式增长只重渲染末尾块，稳定块不重复解析", async () => {
    renderCounts.clear();
    const { rerender } = render(<Markdown>{"para1\n\npara2"}</Markdown>);
    await waitFor(() => expect(renderCounts.get("para1")).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(renderCounts.get("para2")).toBeGreaterThanOrEqual(1));
    // 懒加载 resolve 后可能还有 pending 的重试渲染；用一次同文本重渲染把调度队列冲刷干净，
    // 确认稳定后才取基线，否则 pending 渲染会落在基线之后造成误判
    rerender(<Markdown>{"para1\n\npara2"}</Markdown>);
    await act(async () => {});
    const stableRenders = renderCounts.get("para1")!;

    rerender(<Markdown>{"para1\n\npara2 extended"}</Markdown>);
    await act(async () => {});
    expect(renderCounts.get("para2 extended")).toBeGreaterThanOrEqual(1);
    expect(renderCounts.get("para1")).toBe(stableRenders);
  });

  it("父组件用相同文本重渲染时任何块都不重复解析", async () => {
    renderCounts.clear();
    const text = "para1\n\npara2";
    const { rerender } = render(<Markdown>{text}</Markdown>);
    await waitFor(() => expect(renderCounts.get("para2")).toBeGreaterThanOrEqual(1));
    const snapshot = new Map(renderCounts);

    rerender(<Markdown>{text}</Markdown>);
    rerender(<Markdown>{text}</Markdown>);
    expect(renderCounts).toEqual(snapshot);
  });
});
