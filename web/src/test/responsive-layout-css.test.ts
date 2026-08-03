import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const narrowStart = css.indexOf("@media (max-width: 1024px)");
const narrowEnd = css.indexOf("@media (max-width: 480px)", narrowStart);
const narrowCss = css.slice(narrowStart, narrowEnd);

describe("窄窗口布局 CSS 回归", () => {
  it("窄屏不渲染桌面活动栏：导航走左上角左侧滑出菜单", () => {
    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(narrowCss).toMatch(/\.wb-activity\s*\{\s*display:\s*none;/s);
    // 滑出菜单样式在媒体块外（组件仅移动端渲染）：左侧固定竖向列表，条目 ≥44px 点击目标
    expect(css).toMatch(/\.mobile-nav\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;/s);
    expect(css).toMatch(/\.mobile-nav-backdrop\s*\{[^}]*position:\s*fixed;/s);
    expect(css).toMatch(/\.mobile-nav-item\s*\{[^}]*min-height:\s*44px;/s);
    // 触发钮只能显示不能隐藏：禁止出现 display: none（曾因此按钮被级联隐藏，裸 logo 不可见/不可点）
    expect(css).not.toMatch(/\.mobile-nav-trigger\s*\{[^}]*display:\s*none/);
    // 触发钮要有明确按钮外观（边框），裸 logo 没有可点击感
    expect(css).toMatch(/\.mobile-nav-trigger\s*\{[^}]*border:\s*1px solid/s);
    // 面板模式：图标栏固定贴左，侧栏右移 52px 让位（图标栏 + 右侧整屏面板）
    expect(css).toMatch(/\.mobile-explorer-rail\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;/s);
    expect(narrowCss).toMatch(/\.wb-sidebar\s*\{[^}]*left:\s*52px;/s);
  });

  it("设置三栏结构（应用导航轨 | 设置项 | 详情），移动端整页 + 钻取", () => {
    // 桌面三栏栅格；设置页内的导航轨随文档流（不再 fixed）
    expect(css).toMatch(/\.settings-layout\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*52px 204px/s);
    expect(css).toMatch(/\.settings-dialog \.mobile-explorer-rail\s*\{[^}]*position:\s*static;/s);
    // 移动端：整页（非浮窗，与桌面一致），列表/详情互斥钻取，返回钮可见
    expect(css).toMatch(/\.settings-dialog\s*\{[^}]*width:\s*100vw;[^}]*border-radius:\s*0;/s);
    expect(narrowCss).toMatch(/\.settings-layout\.detail-open \.settings-nav\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.settings-layout\.detail-open \.settings-content\s*\{[^}]*display:\s*flex;/s);
    expect(narrowCss).toMatch(/\.settings-back\s*\{\s*display:\s*inline-flex;/s);
    // 抽屉/图标栏不带投影，且与菜单共用同一滑入动画
    expect(narrowCss).not.toMatch(/\.wb-sidebar\s*\{[^}]*box-shadow/);
    expect(css).not.toMatch(/\.mobile-explorer-rail\s*\{[^}]*box-shadow/);
    expect(narrowCss).toMatch(/\.wb-sidebar\s*\{\s*animation:\s*mobile-nav-in/s);
  });

  it("窄屏编辑器/diff 为覆盖主区的全屏临时视图", () => {
    expect(narrowCss).toMatch(/\.wb-main > \.wb-main-split\s*\{[^}]*position:\s*relative;/s);
    expect(narrowCss).toMatch(/\.editor-pane\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*max-width:\s*none;/s);
  });

  it("窄屏底部标签条不横滚：常驻标签收缩、第二行折叠区独立成行", () => {
    expect(narrowCss).toMatch(/\.panel-tabs\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(narrowCss).toMatch(/\.panel-tabs-secondary\s*\{[^}]*border-top:/s);
    // 顶栏两行结构：行1 信息区收缩省略、行2 选项单行胶囊缩短（均不横滚）
    expect(narrowCss).toMatch(/\.job-info\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow:\s*hidden;/s);
    expect(narrowCss).toMatch(/\.job-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s);
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

  it("≤768px 密度优化：芯片行压扁、信息条单行收缩省略、表格降档、消息区收边", () => {
    const compactStart = css.indexOf("@media (max-width: 768px)", narrowStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    const compactCss = css.slice(compactStart, css.indexOf("@media (max-width: 480px)", compactStart));
    expect(compactCss).toMatch(/\.composer-chips\s*\{[^}]*margin:\s*0 0 4px;/s);
    expect(compactCss).toMatch(/\.job-info\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(compactCss).toMatch(/\.budget-bar\s*\{[^}]*width:\s*28px;/s);
    expect(compactCss).toMatch(/\.markdown th, \.markdown td\s*\{[^}]*padding:\s*3px 6px;/s);
    expect(compactCss).toMatch(/\.execution-track\s*\{[^}]*padding-left:\s*12px;/s);
  });

  it("≤480px 控制行紧凑：按钮降档、长模型名收缩省略", () => {
    const tinyCss = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(tinyCss).toMatch(/\.composer-menu-btn\s*\{[^}]*min-height:\s*28px;/s);
    expect(tinyCss).toMatch(/\.model-menu-btn-label\s*\{[^}]*max-width:\s*108px;/s);
    expect(tinyCss).toMatch(/\.composer-send\s*\{[^}]*width:\s*30px;/s);
  });

  it("输入框默认无纵向滚动条轨道（溢出后由 JS 放开）", () => {
    expect(css).toMatch(/\.composer textarea\s*\{[^}]*overflow-y:\s*hidden;/s);
  });
});
