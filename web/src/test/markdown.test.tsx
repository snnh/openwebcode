import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";

describe("Markdown", () => {
  it("renders GFM tables and task lists", () => {
    const source = "| 项目 | 状态 |\n| --- | --- |\n| Markdown | 完成 |\n\n- [x] 支持表格";
    const { container } = render(<Markdown>{source}</Markdown>);

    expect(container.querySelector("table")).toBeInTheDocument();
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it("renders inline and display LaTeX with KaTeX", () => {
    const source = "欧拉公式 $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$";
    const { container } = render(<Markdown>{source}</Markdown>);

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });
});
