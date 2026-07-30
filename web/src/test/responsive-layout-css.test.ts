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

  it("会话配置收进输入卡片底栏，窄窗口允许换行且芯片行可横滚", () => {
    expect(css).toMatch(/\.composer-toolbar\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(css).toMatch(/\.composer-toolbar-spacer\s*\{\s*flex:\s*1 1 auto;/s);
    expect(css).toMatch(/\.composer-menu-right \.popover-menu\s*\{[^}]*right:\s*0;/s);
    expect(narrowCss).toMatch(/\.composer\s*\{[^}]*position:\s*sticky;/s);
    expect(narrowCss).toMatch(/\.composer-menu-badge\s*\{\s*display:\s*none;/s);
    const tinyCss = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(tinyCss).toMatch(/\.composer-toolbar\s*\{\s*flex-wrap:\s*wrap;/s);
    expect(tinyCss).toMatch(/\.composer-chips\s*\{[^}]*overflow-x:\s*auto;/s);
  });
});
