import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const narrowStart = css.indexOf("@media (max-width: 1024px)");
const narrowEnd = css.indexOf("@media (max-width: 480px)", narrowStart);
const narrowCss = css.slice(narrowStart, narrowEnd);

describe("窄窗口布局 CSS 回归", () => {
  it("顶栏选择器能覆盖后置的桌面活动栏规则", () => {
    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(narrowCss).toMatch(/\.wb-activity > \.activity-bar\s*\{[^}]*flex-direction:\s*row;/s);
    expect(narrowCss).toMatch(/\.wb-activity \.activity-bar-bottom\s*\{[^}]*margin:\s*0 0 0 auto;/s);
    expect(narrowCss).toMatch(/\.wb-activity \.activity-mobile-brand\s*\{[^}]*display:\s*inline-block;/s);
  });

  it("主区、底部面板和状态栏共享同一纵向视口", () => {
    expect(narrowCss).toMatch(/\.console-shell\.wb-shell\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(narrowCss).toMatch(/\.wb-main\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;/s);
    expect(narrowCss).toMatch(/\.wb-bottom, \.wb-status\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(narrowCss).toMatch(/\.workbench\s*\{[^}]*height:\s*100%;/s);
    expect(narrowCss).not.toContain("calc(100dvh - 53px)");
  });

  it("会话配置限制模型框宽度，窄窗口不再让高级设置单独靠右", () => {
    expect(css).toMatch(/\.composer-model-field\s*\{[^}]*flex:\s*0 1 320px;[^}]*max-width:\s*320px;/s);
    expect(narrowCss).toMatch(/\.composer-model-field\s*\{[^}]*flex:\s*0 1 300px;[^}]*max-width:\s*300px;/s);
    expect(narrowCss).toMatch(/\.composer-config-toggle\s*\{[^}]*margin-left:\s*0;/s);
  });
});
