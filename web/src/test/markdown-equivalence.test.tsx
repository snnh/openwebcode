import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownImpl from "../components/MarkdownImpl";
import { Markdown } from "../components/Markdown";

// 高亮走动态 import，固定为纯文本路径，保证两条渲染路径的 DOM 可逐字节比较
vi.mock("../highlight", () => ({ highlightCode: vi.fn(async () => null) }));

// 覆盖：标题、段落+行内公式、列表、含空行的代码围栏、块级公式、GFM 表格
const FIXTURE = [
  "# 标题",
  "",
  "第一段，含行内公式 $e^{i\\pi}+1=0$ 与 **粗体**。",
  "",
  "- 列表项一",
  "- 列表项二",
  "- 列表项三",
  "",
  "```plain",
  "line 1",
  "",
  "line 3",
  "```",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| a | b |",
].join("\n");

describe("Markdown 分块渲染等价性", () => {
  it("分块渲染与整篇渲染产出完全相同的 DOM", async () => {
    const full = render(<MarkdownImpl>{FIXTURE}</MarkdownImpl>);
    const split = render(<Markdown>{FIXTURE}</Markdown>);
    await waitFor(() => expect(split.container.querySelector("table")).toBeInTheDocument());

    const fullHtml = full.container.querySelector(".markdown")!.innerHTML;
    const splitHtml = split.container.querySelector(".markdown")!.innerHTML;
    expect(splitHtml).toBe(fullHtml);
  });

  it("分块渲染保留各语法元素（标题/列表/代码/公式/表格）", async () => {
    const { container } = render(<Markdown>{FIXTURE}</Markdown>);
    await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());

    expect(container.querySelector("h1")).toHaveTextContent("标题");
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector(".code-block")).toBeInTheDocument();
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });
});
