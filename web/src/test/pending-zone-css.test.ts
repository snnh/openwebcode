import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// 待回答区护栏的 CSS 回归守卫（jsdom 无布局，只能断言规则本身）。
// 主列 .wb-main 是 overflow:hidden 且不自我滚动——丢了 min-height:0 与列表保底，
// 卡片底部（选项/提交按钮）与 Composer 会被直接裁掉且滚不到。
const css = readFileSync(resolve(process.cwd(), "src/styles/chat-cards.css"), "utf8");
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  return css.slice(start, css.indexOf("}", start) + 1);
}
describe("待回答区 CSS 护栏", () => {
  it("容器可收缩、卡片内容区与运行队列限高内滚，消息列表保底 120px", () => {
    expect(rule(".pending-zone")).toContain("min-height: 0");
    const body = rule(".pending-body");
    expect(body).toContain("max-height: var(--pending-body-max, 60vh)");
    expect(body).toContain("overflow-y: auto");
    expect(rule(".main-tab-panel.chat-panel")).toContain("min-height: 120px");
    const queue = rule(".steering-queue");
    expect(queue).toContain("max-height: var(--pending-body-max, 60vh)");
    expect(queue).toContain("overflow-y: auto");
  });
});