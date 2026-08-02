import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "../components/ComposerPopovers";

/**
 * Popover 视口内定位（移动端「模式」菜单右缘被裁的修复回归）：
 * jsdom 无布局，offsetWidth/offsetHeight 恒为 0，组件回退假定 320x240；
 * jsdom 默认视口 1024x768。
 */

function mockAnchorRect(rect: Partial<DOMRect>): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

function renderPopover() {
  render(
    <div className="composer-menu">
      <button type="button">触发</button>
      <Popover open onClose={() => undefined}>
        <div>菜单内容</div>
      </Popover>
    </div>,
  );
  return screen.getByRole("menu");
}

afterEach(() => vi.restoreAllMocks());

describe("Popover 视口内 clamp 定位", () => {
  it("触发按钮贴近视口右缘时，菜单左缘被 clamp 回不溢出（1024 - 320 - 8 = 696）", () => {
    mockAnchorRect({ left: 900, top: 600, bottom: 632, right: 980, width: 80, height: 32 });
    const menu = renderPopover();
    expect(menu.classList.contains("popover-menu-anchored")).toBe(true);
    expect(menu.style.left).toBe("696px");
    // 上方空间充足：锚在触发按钮上方（600 - 6 - 240 = 354）
    expect(menu.style.top).toBe("354px");
  });

  it("触发按钮贴近左缘时，菜单左缘不小于 8px 安全边距", () => {
    mockAnchorRect({ left: -40, top: 600, bottom: 632, right: 40, width: 80, height: 32 });
    const menu = renderPopover();
    expect(menu.style.left).toBe("8px");
  });

  it("上方空间不足时翻到触发按钮下方", () => {
    mockAnchorRect({ left: 100, top: 100, bottom: 132, right: 180, width: 80, height: 32 });
    const menu = renderPopover();
    // 上方 100 - 6 - 240 < 8 → 翻到下方 132 + 6 = 138
    expect(menu.style.top).toBe("138px");
  });
});
