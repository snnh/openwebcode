import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeView } from "../components/editor/CodeView";
import { clearHighlightCache } from "../highlight";

const CODE = `const a = 1;
function add(x: number, y: number) {
  return x + y;
}
console.log(add(a, 2));`;

describe("CodeView（只读代码视图）", () => {
  it("渲染行号与纯文本内容（不支持的语言回退纯文本）", () => {
    const { container } = render(<CodeView code={CODE} lang="cobol" />);
    const lines = container.querySelectorAll(".code-view-line");
    expect(lines).toHaveLength(5);
    expect(container.querySelectorAll(".code-view-no")[4]?.textContent).toBe("5");
    expect(lines[2]?.textContent).toContain("return x + y;");
  });

  it("跳转到目标行并高亮该行", () => {
    const { container } = render(<CodeView code={CODE} targetLine={3} targetColumn={7} />);
    const target = container.querySelector(".code-view-line.code-view-target");
    expect(target).toBeInTheDocument();
    expect(target?.querySelector(".code-view-no")?.textContent).toBe("3");
    expect(target?.getAttribute("aria-label")).toContain("第 3 行");
    expect(target?.getAttribute("aria-label")).toContain("第 7 列");
    expect(container.querySelectorAll(".code-view-target")).toHaveLength(1);
  });

  it("目标行越界时不高亮任何行", () => {
    const { container } = render(<CodeView code={CODE} targetLine={99} />);
    expect(container.querySelector(".code-view-target")).not.toBeInTheDocument();
  });

  it("Shiki 按行高亮就绪后注入 span（沿用动态加载机制）", async () => {
    clearHighlightCache();
    const { container } = render(<CodeView code={CODE} lang="typescript" />);
    await waitFor(() => expect(container.querySelector(".code-view-text span")).toBeInTheDocument());
    // 行数与高亮片段一一对应
    expect(container.querySelectorAll(".code-view-line")).toHaveLength(5);
  });

  it("超过行数上限时截断并提示", () => {
    const big = Array.from({ length: 2100 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container, getByText } = render(<CodeView code={big} />);
    expect(container.querySelectorAll(".code-view-line")).toHaveLength(2000);
    expect(getByText(/仅显示前 2000 行/)).toBeInTheDocument();
  });
});
