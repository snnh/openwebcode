import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 待回答区护栏的 CSS 回归守卫（jsdom 无布局，只能断言规则本身）。
 * 背景：主列 .wb-main 是 overflow: hidden 且自身不滚动，权限/交互/计划批准/运行队列
 * 又是消息列表之外的兄弟节点——一旦丢了下限高与列表保底，卡片底部（选项/提交按钮）
 * 与 Composer 会被直接裁掉且滚不到（真机表现为「框被截断、挡着回答」）。
 */
const css = readFileSync(resolve(process.cwd(), "src/styles/chat-cards.css"), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

describe("待回答区 CSS 护栏", () => {
  it("容器可收缩：flex 收缩 + min-height 0（否则 flex 项不会让位给列表与输入框）", () => {
    const zone = rule(".pending-zone");
    expect(zone).toContain("flex: 0 1 auto");
    expect(zone).toContain("min-height: 0");
  });

  it("卡片内容区限高内滚：max-height 用 --pending-body-max（由 ChatView 按可用高度写入）", () => {
    const body = rule(".pending-body");
    expect(body).toContain("max-height: var(--pending-body-max, 60vh)");
    expect(body).toContain("overflow-y: auto");
  });

  it("消息列表保底 120px（与 PENDING_LIST_FLOOR 一致），卡片再高也留住上下文", () => {
    expect(rule(".main-tab-panel.chat-panel")).toContain("min-height: 120px");
  });

  it("运行队列同样限高内滚（四类待回答块共用一处护栏）", () => {
    const queue = rule(".steering-queue");
    expect(queue).toContain("max-height: var(--pending-body-max, 60vh)");
    expect(queue).toContain("overflow-y: auto");
  });

  it("收起态只占一行：卡头与操作行收边，不保留正文间距", () => {
    const collapsed = rule(".pending-block.collapsed");
    expect(collapsed).toContain("padding-top");
    expect(css).toContain(".pending-block.collapsed .pending-head { margin-bottom: 0; }");
  });
});
