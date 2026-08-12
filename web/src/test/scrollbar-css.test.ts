import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const base = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

/** 悬停显现滚动条的结构契约（渲染语义见 base.css 顶部注释） */
describe("悬停显现滚动条 CSS", () => {
  it("tokens.css 定义拇指间接层；Firefox 标准属性置于 @supports not selector(::-webkit-scrollbar) 内（与 WebKit 伪元素互斥）", () => {
    expect(tokens).toContain("--scrollbar-thumb: var(--border-strong)");
    expect(tokens).toContain("--scrollbar-thumb-hover: var(--text-3)");
    const block = base.match(/@supports not selector\(::-webkit-scrollbar\) \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain("scrollbar-width: thin");
    expect(block![0]).toContain("scrollbar-color: transparent transparent");
    expect(block![0]).toContain("scrollbar-color: var(--scrollbar-thumb) transparent");
  });

  it("拇指静止透明、容器 hover/focus-within 显现、拇指 hover 深一档；无常驻着色回归", () => {
    expect(base).toContain("::-webkit-scrollbar-thumb { background: transparent;");
    expect(base).toContain("*:hover::-webkit-scrollbar-thumb, *:focus-within::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); }");
    expect(base).toContain("::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }");
    expect(base).not.toContain("scrollbar-color: var(--border-strong) transparent");
    expect(base).not.toContain("::-webkit-scrollbar-thumb { background: var(--border-strong)");
  });
});
