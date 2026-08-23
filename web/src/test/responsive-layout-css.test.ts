import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";

/** 新样式体系（src/styles/ 十二个文件）合并文本；媒体块按断点抽取 */
const FILES = [
  "tokens.css", "base.css", "layout.css", "chat-list.css", "chat-cards.css",
  "composer.css", "sidebar.css", "panels.css", "editor.css", "dialogs.css", "settings.css",
  "chat-mode.css",
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

/** 手机断点（移动布局 + 密度优化）；平板（>768px）直接用桌面布局 */
const narrowCss = mediaBlock(768);
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

  it("设置两栏结构（设置项 | 详情），手机整页 + 钻取", () => {
    // 桌面两栏栅格（应用导航轨已裁剪）
    expect(css).toMatch(/\.settings-layout\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*204px/s);
    // 手机：整页（非浮窗），列表/详情互斥钻取，返回钮可见
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

  it("会话配置收进输入卡片底栏，窄窗口控制条同排靠左且菜单徽章降噪", () => {
    expect(css).toMatch(/\.composer-toolbar\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(css).toMatch(/\.composer-toolbar-spacer\s*\{\s*flex:\s*1 1 auto;/s);
    expect(css).toMatch(/\.composer-menu-right \.popover-menu\s*\{[^}]*right:\s*0;/s);
    expect(narrowCss).toMatch(/\.composer-menu-badge\s*\{\s*display:\s*none;/s);
    // 窄窗口（≤768px）控制条单行：附件/权限/模式/模型选择器（+运行中队列菜单）整体靠左，
    // 发送按钮同行右端；spacer 收起不吸宽；运行状态行（文本/圆点）已移除，状态统一在会话头
    expect(narrowCss).toMatch(/\.composer-toolbar-spacer\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.composer-toolbar\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(narrowCss).toMatch(/\.composer-send\s*\{\s*margin-left:\s*auto;/s);
    expect(narrowCss).toMatch(/\.model-menu-btn-label\s*\{[^}]*max-width:\s*30vw;/s);
    // 运行队列行为选择为分段单选（补充/续跑），窄屏紧凑化且不收缩
    expect(css).toMatch(/\.queue-option\.selected\s*\{[^}]*color:\s*var\(--accent\);/s);
    expect(narrowCss).toMatch(/\.composer-toolbar\s*>\s*\.composer-queue-menu\s*\{\s*flex:\s*0 0 auto;\s*\}/s);
    expect(narrowCss).toMatch(/\.queue-option\s*\{[^}]*min-height:\s*30px;/s);
    // 附件/引用条折行而非横滚（移动端禁横向滚动纪律）
    expect(css).toMatch(/\.mention-strip\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).toMatch(/\.attachment-strip\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).not.toMatch(/\.mention-strip\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).not.toMatch(/\.attachment-strip\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it("手机密度优化：信息条折行 + 单位缩写 tok、表格降档、消息区收边", () => {
    expect(narrowCss).toMatch(/\.unit-full\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.unit-narrow\s*\{\s*display:\s*inline;/s);
    expect(narrowCss).toMatch(/\.markdown th, \.markdown td\s*\{[^}]*padding:\s*3px 6px;/s);
    expect(narrowCss).toMatch(/\.chat-track\s*\{[^}]*padding:\s*14px 12px/s);
  });

  it("≤480px 控制行紧凑：模型名收得更短，发送钮保持 44px 触达目标", () => {
    expect(tinyCss).toMatch(/\.composer-menu-btn\s*\{[^}]*padding:\s*0 5px;/s);
    expect(tinyCss).toMatch(/\.model-menu-btn-label\s*\{[^}]*max-width:\s*96px;/s);
    // 触屏触控目标（hover:none 块）
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.composer-send\s*\{[^}]*width:\s*44px;/);
  });

  it("输入框默认无纵向滚动条轨道（溢出后由 JS 放开）", () => {
    expect(css).toMatch(/\.composer textarea\s*\{[^}]*overflow-y:\s*hidden;/s);
  });

  it("对话框移动端：输入防 iOS 聚焦放大、按钮行允许换行、浮层底部安全区", () => {
    // iOS Safari 聚焦 <16px 输入框会自动放大页面：命令面板/QuickOpen 与原生 dialog 输入框手机端 16px
    expect(narrowCss).toMatch(/\.wb-overlay-input\s*\{[^}]*font-size:\s*16px;/s);
    expect(narrowCss).toMatch(/\.session-dialog \.input, \.session-dialog select\s*\{[^}]*font-size:\s*16px;/s);
    // 新建会话的绑定/备选模型行与确认按钮行窄屏换行
    expect(narrowCss).toMatch(/\.dialog-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(narrowCss).toMatch(/\.bindlink-row\s*\{[^}]*flex-wrap:\s*wrap;/s);
    // 通用浮层（命令面板/QuickOpen/CodeOverlay/chat 弹层）底部避开 Home 指示条
    expect(narrowCss).toMatch(/\.wb-overlay\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\);/s);
    // 备选模型行 select 按最长 option 定宽：容器允许收缩，防超长模型名在窄屏撑出横滚
    expect(css).toMatch(/\.bindlink-row select\s*\{[^}]*min-width:\s*0;/s);
  });

  it("chat 模式手机端：侧栏变覆盖式抽屉 + 输入 16px + 100dvh", () => {
    // 单列：侧栏脱离网格成为 fixed 抽屉，折叠态同断点覆盖桌面 0 1fr 规则
    expect(narrowCss).toMatch(/\.chat-mode-shell,\s*\.chat-mode-shell\.sidebar-collapsed\s*\{\s*grid-template-columns:\s*1fr;/s);
    expect(narrowCss).toMatch(/\.chat-mode-shell \.chat-sidebar\s*\{[^}]*position:\s*fixed;/s);
    expect(narrowCss).toMatch(/\.chat-mode-shell\.sidebar-collapsed \.chat-sidebar\s*\{\s*display:\s*none;/s);
    expect(narrowCss).toMatch(/\.chat-sidebar-backdrop\s*\{[^}]*position:\s*fixed;/s);
    // 对话弹层窄屏不设最小宽度（防 320px 视口横向溢出）
    expect(narrowCss).toMatch(/\.chat-dialog\s*\{[^}]*min-width:\s*0;/s);
    // iOS 输入聚焦防自动放大
    expect(narrowCss).toMatch(/\.chat-composer-input\s*\{[^}]*font-size:\s*16px;/s);
    // 移动端纵向视口统一 100dvh（iOS 地址栏不遮挡）
    expect(css).toMatch(/\.chat-mode-shell\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s);
    // 触屏：会话菜单常显（hover-only 在触屏不可见）
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.chat-session-item \.chat-session-menu\s*\{[^}]*opacity:\s*1;/);
    expect(css).toMatch(/@media \(hover: none\)[\s\S]*?\.chat-message \.actions\s*\{[^}]*opacity:\s*1;/);
  });

  it("AskUser/Plan/权限悬浮卡窄屏允许换行收边", () => {
    expect(css).toMatch(/\.permission-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).toMatch(/\.interaction-card > \.interaction-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(css).toMatch(/\.interaction-card \.interaction-other\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(tinyCss).toMatch(/\.interaction-card\s*\{[^}]*margin:\s*8px 12px;/s);
  });
});

interface MockMQL {
  matches: boolean;
  media: string;
  addEventListener: (type: string, listener: (event: { matches: boolean }) => void) => void;
  removeEventListener: (type: string, listener: (event: { matches: boolean }) => void) => void;
}

function mockMatchMedia(initial: boolean): { setMatches(next: boolean): void; calls: string[] } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const calls: string[] = [];
  const mql: MockMQL = {
    matches: initial,
    media: "",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    calls.push(query);
    mql.media = query;
    return mql;
  });
  return {
    calls,
    setMatches(next: boolean): void {
      mql.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery（移动端断点 state 层，§6.8）", () => {
  it("初始读取 matchMedia 结果", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    expect(result.current).toBe(true);
  });

  it("断点跨越时随 change 事件切换（窄↔宽）", () => {
    const mql = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    expect(result.current).toBe(false);
    act(() => mql.setMatches(true));
    expect(result.current).toBe(true);
    act(() => mql.setMatches(false));
    expect(result.current).toBe(false);
  });

  it("卸载后移除监听", () => {
    const mql = mockMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery(MOBILE_BREAKPOINT));
    unmount();
    act(() => mql.setMatches(true));
    expect(result.current).toBe(false);
  });
});
