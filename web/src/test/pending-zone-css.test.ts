import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// 待回答区护栏的 CSS 回归守卫（jsdom 无布局，只能断言规则本身）。
// 主列 .wb-main 是 overflow:hidden 且不自我滚动——丢了 min-height:0 与列表保底，
// 卡片底部（选项/提交按钮）与 Composer 会被直接裁掉且滚不到。
// 高度上限只加在容器 .pending-zone 上：卡内容完整渲染、由容器整体滚动，
// 截断卡内容（选项被截在中间）是明确要避免的旧行为。
const css = readFileSync(resolve(process.cwd(), "src/styles/chat-cards.css"), "utf8");
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  return css.slice(start, css.indexOf("}", start) + 1);
}
describe("待回答区 CSS 护栏", () => {
  it("容器可收缩且限高内滚；消息列表不再保底（卡展开时铺满整个信息流区域）", () => {
    const zone = rule(".pending-zone");
    expect(zone).toContain("min-height: 0");
    expect(zone).toContain("max-height: var(--pending-zone-max, 60vh)");
    expect(zone).toContain("overflow-y: auto");
    expect(rule(".main-tab-panel.chat-panel")).toContain("min-height: 0");
  });
  it("卡内容与运行队列不再自限高（避免把选项截在中间）", () => {
    expect(rule(".pending-body")).toContain("overflow: visible");
    expect(rule(".pending-body")).not.toContain("max-height");
    expect(rule(".steering-queue")).not.toContain("max-height");
  });
  it("卡头吸附容器顶部：卡铺满后折叠入口仍常驻可见", () => {
    const head = rule(".pending-zone .pending-block:not(.collapsed) > .pending-head");
    expect(head).toContain("position: sticky");
    expect(head).toContain("top: 0");
    const at = css.indexOf(".pending-zone .pending-block:not(.collapsed) > .pending-head {");
    expect(at).toBeGreaterThan(-1);
    expect(braceDepth(at)).toBe(0);
  });
  it("操作行吸附容器底部常驻可见（桌面与移动端同一规则）", () => {
    const actions = rule(".pending-zone .interaction-actions,\n.pending-zone .permission-actions");
    expect(actions).toContain("position: sticky");
    expect(actions).toContain("bottom: 0");
    // 该规则在顶层（不嵌在任何 @media 里）：窄屏只补充触屏细节
    const at = css.indexOf(".pending-zone .interaction-actions,\n.pending-zone .permission-actions {");
    expect(at).toBeGreaterThan(-1);
    expect(braceDepth(at)).toBe(0);
  });
});

/** 某偏移处的 CSS 嵌套深度（0 = 顶层，1+ = 位于 @media 等块内） */
function braceDepth(index: number): number {
  let depth = 0;
  for (const char of css.slice(0, index)) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth;
}
