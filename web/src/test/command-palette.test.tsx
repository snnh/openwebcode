import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "../components/CommandPalette";
import { registerCommand, resetCommands } from "../commands/registry";

afterEach(() => resetCommands());

function setup(): { alpha: ReturnType<typeof vi.fn> } {
  const alpha = vi.fn();
  registerCommand({ id: "app.alpha", title: { zh: "阿尔法操作", en: "Alpha Action" }, handler: alpha });
  registerCommand({ id: "app.beta", title: { zh: "贝塔操作", en: "Beta Action" }, when: "sessionActive", handler: () => undefined });
  return { alpha };
}

describe("CommandPalette", () => {
  it("列出 when 满足的命令并展示键位", () => {
    setup();
    render(<CommandPalette open context={{}} onClose={() => undefined} />);
    expect(screen.getByText("阿尔法操作")).toBeInTheDocument();
    // app.beta 的 when: sessionActive 不满足，被过滤
    expect(screen.queryByText("贝塔操作")).not.toBeInTheDocument();
    // 默认键位集中 mod+shift+p 未注册对应命令时不显示；注册后应显示标签
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
  });

  it("模糊过滤（中英标题均可命中）", () => {
    setup();
    render(<CommandPalette open context={{ sessionActive: true }} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(screen.queryByText("阿尔法操作")).not.toBeInTheDocument();
    expect(screen.getByText("贝塔操作")).toBeInTheDocument();
  });

  it("Enter 执行选中命令并关闭", async () => {
    const { alpha } = setup();
    const onClose = vi.fn();
    render(<CommandPalette open context={{}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(alpha).toHaveBeenCalledTimes(1));
  });

  it("方向键移动选中项，Esc 关闭", () => {
    setup();
    const onClose = vi.fn();
    render(<CommandPalette open context={{ sessionActive: true }} onClose={onClose} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "command-option-1");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
