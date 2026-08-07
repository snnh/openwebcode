import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** 新样式体系（src/styles/ 十一个文件）合并文本；媒体块按断点抽取 */
const FILES = [
  "tokens.css", "base.css", "layout.css", "chat-list.css", "chat-cards.css",
  "composer.css", "sidebar.css", "panels.css", "editor.css", "dialogs.css", "settings.css",
];
const css = FILES.map((file) => readFileSync(resolve(process.cwd(), `src/styles/${file}`), "utf8")).join("\n");

function mediaBlock(width: number): string {
  const out: string[] = [];
  const marker = `@media (max-width: ${width}px) {`;
  let index = 0;
  for (;;) {
    const start = css.indexOf(marker, index);
    if (start < 0) break;
    let depth = 0;
    for (let k = start; k < css.length; k++) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") {
        depth--;
        if (depth === 0) {
          out.push(css.slice(start, k + 1));
          index = k + 1;
          break;
        }
      }
    }
  }
  return out.join("\n");
}

const narrowCss = mediaBlock(1024);
const compactCss = mediaBlock(768);
const tinyCss = mediaBlock(480);

describe("窄窗口布局 CSS 回归", () => {
  it("窄屏不渲染桌面活动栏：导航走左上角左侧滑出菜单", () => {
    expect(narrowCss).toMatch(/\.wb-activity\s*\{\s*display:\s*none;/s);
    // 滑出菜单样式在媒体块外（组件仅移动端渲染）：左侧固定竖向列表，条目 ≥44px 点击目标
    expect(css).toMatch(/\.mobile-nav\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;/s);
    expect(css).toMatch(/\.mobile-nav-backdrop\s*\{[^}]*position:\s*fixed;/s);
    expect(css).toMatch(/\.mobile-nav-item\s*\{[^}]*min-height:\s*44px;/s);
    // 触发钮是窄屏唯一导航入口，点击目标同样需 ≥44px；桌面基态隐藏、窄屏强制显示
    expect(css).toMatch(/\.mobile-nav-trigger\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.mobile-nav-trigger\s*\{[^}]*display:\s*inline-flex;/s);
    expect(narrowCss).toMatch(/\.mobile-nav-trigger\s*\{[^}]*min-height:\s*44px;/s);
    expect(narrowCss).toMatch(/\.mobile-nav-trigger\s*\{[^}]*min-width:\s*44px;/s);
    // 触发钮为无边框纯图标（顶栏纯文本语言），不挂胶囊外框
    expect(narrowCss).toMatch(/\.mobile-nav-trigger\s*\{[^}]*border:\s*none;/s);
    // 侧栏抽屉：固定覆盖 + 遮罩
    expect(narrowCss).toMatch(/\.wb-sidebar\s*\{[^}]*position:\s*fixed;/s);
    expect(narrowCss).toMatch(/\.wb-sidebar-backdrop\s*\{[^}]*position:\s*fixed;/s);
  });

  it("设置两栏结构（设置项 | 详情），移动端整页 + 钻取", () => {
    // 桌面两栏栅格（应用导航轨已裁剪）
    expect(css).toMatch(/\.settings-layout\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*204px/s);
    // 移动端：整页（非浮窗），列表/详情互斥钻取，返回钮可见
    expect(css).toMatch(/\.settings-dialog\s*\{[^}]*width:\s*100vw;[^}]*border-radius:\s*0;/s);
    expect(narrowCss).toMatch(/\.settings-layout\.detail-open \.settings-nav\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.settings-layout\.detail-open \.settings-content\s*\{[^}]*display:\s*flex;/s);
    expect(narrowCss).toMatch(/\.settings-back\s*\{\s*display:\s*inline-flex;/s);
  });

  it("窄屏编辑器/diff 为覆盖主区的全屏临时视图", () => {
    expect(narrowCss).toMatch(/\.wb-main > \.wb-main-split\s*\{[^}]*position:\s*relative;/s);
    expect(narrowCss).toMatch(/\.editor-pane\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*max-width:\s*none;/s);
  });

  it("窄屏底部标签条不横滚：常驻标签收缩、第二行折叠区独立成行", () => {
    expect(narrowCss).toMatch(/\.panel-tabs\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(narrowCss).toMatch(/\.panel-tabs-secondary\s*\{[^}]*border-top:/s);
    // 顶栏两行结构：行1 不折行（nowrap），行2 为独立 .job-header-sub 容器（cwd+状态+展开钮）
    expect(narrowCss).toMatch(/\.job-header-info\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(narrowCss).toMatch(/\.job-header-sub\s*\{[^}]*display:\s*flex;/s);
    expect(narrowCss).not.toMatch(/\.job-info\s*\{[^}]*overflow-x:\s*auto/s);
    expect(narrowCss).toMatch(/\.job-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(narrowCss).toMatch(/\.budget-bar\s*\{[^}]*width:\s*28px;/s);
  });

  it("主区、底部面板和状态栏共享同一纵向视口", () => {
    expect(narrowCss).toMatch(/\.console-shell\.wb-shell\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(narrowCss).toMatch(/\.wb-main\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;/s);
    expect(narrowCss).toMatch(/\.wb-status\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(narrowCss).toMatch(/\.workbench\s*\{[^}]*height:\s*100%;/s);
    expect(narrowCss).not.toContain("calc(100dvh - 53px)");
  });

  it("会话配置收进输入卡片底栏，窄窗口允许换行且菜单徽章降噪", () => {
    expect(css).toMatch(/\.composer-toolbar\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(css).toMatch(/\.composer-toolbar-spacer\s*\{\s*flex:\s*1 1 auto;/s);
    expect(css).toMatch(/\.composer-menu-right \.popover-menu\s*\{[^}]*right:\s*0;/s);
    expect(narrowCss).toMatch(/\.composer-menu-badge\s*\{\s*display:\s*none;/s);
    // 控制条同排放下：菜单按钮降档、模型名收缩省略、spacer 吸剩余宽度
    expect(narrowCss).toMatch(/\.composer-toolbar-spacer\s*\{\s*flex:\s*1 1 0;[^}]*min-width:\s*0;/s);
    expect(narrowCss).toMatch(/\.model-menu-btn-label\s*\{[^}]*max-width:\s*34vw;/s);
    expect(tinyCss).toMatch(/\.composer-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/s);
    // 附件/引用条折行而非横滚（移动端禁横向滚动纪律）
    expect(css).toMatch(/\.mention-strip\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).toMatch(/\.attachment-strip\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).not.toMatch(/\.mention-strip\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).not.toMatch(/\.attachment-strip\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it("≤768px 密度优化：信息条折行 + 单位缩写 tok、表格降档、消息区收边", () => {
    expect(compactCss).toMatch(/\.unit-full\s*\{\s*display:\s*none;/s);
    expect(compactCss).toMatch(/\.unit-narrow\s*\{\s*display:\s*inline;/s);
    expect(compactCss).toMatch(/\.markdown th, \.markdown td\s*\{[^}]*padding:\s*3px 6px;/s);
    expect(compactCss).toMatch(/\.chat-track\s*\{[^}]*padding:\s*14px 12px/s);
  });

  it("≤480px 控制行紧凑：菜单按钮降档、长模型名收缩省略，发送钮保持 44px 触达目标", () => {
    expect(tinyCss).toMatch(/\.composer-menu-btn\s*\{[^}]*padding:\s*0 7px;/s);
    expect(tinyCss).toMatch(/\.model-menu-btn-label\s*\{[^}]*max-width:\s*108px;/s);
    // 触屏触控目标（hover:none 块）
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.composer-send\s*\{[^}]*width:\s*44px;/);
  });

  it("输入框默认无纵向滚动条轨道（溢出后由 JS 放开）", () => {
    expect(css).toMatch(/\.composer textarea\s*\{[^}]*overflow-y:\s*hidden;/s);
  });
});
