import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommand, resetCommands } from "../commands/registry";
import { comboFromEvent, dispatchKeybinding, formatCombo, type Keybinding } from "../commands/keybindings";

afterEach(() => resetCommands());

function keyEvent(init: Partial<KeyboardEvent> & { target?: EventTarget | null }): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target"> {
  return { key: "p", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...init };
}

describe("comboFromEvent", () => {
  it("规范化修饰键与键名", () => {
    expect(comboFromEvent(keyEvent({ key: "P", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+p");
    expect(comboFromEvent(keyEvent({ key: "`", metaKey: true }))).toBe("mod+`");
    expect(comboFromEvent(keyEvent({ key: "F6" }))).toBe("f6");
    expect(comboFromEvent(keyEvent({ key: "?", shiftKey: true }))).toBe("shift+?");
    expect(comboFromEvent(keyEvent({ key: " ", ctrlKey: true }))).toBe("mod+space");
  });

  it("纯修饰键返回 undefined", () => {
    expect(comboFromEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBeUndefined();
    expect(comboFromEvent(keyEvent({ key: "Shift", shiftKey: true }))).toBeUndefined();
  });
});

describe("dispatchKeybinding", () => {
  const bindings: Keybinding[] = [
    { command: "app.palette", key: "mod+shift+p", global: true },
    { command: "app.local", key: "mod+b" },
    { command: "app.gated", key: "mod+g", when: "sessionActive" },
  ];

  function registerAll(): { palette: ReturnType<typeof vi.fn>; local: ReturnType<typeof vi.fn>; gated: ReturnType<typeof vi.fn> } {
    const palette = vi.fn();
    const local = vi.fn();
    const gated = vi.fn();
    registerCommand({ id: "app.palette", title: { zh: "面板", en: "Palette" }, handler: palette });
    registerCommand({ id: "app.local", title: { zh: "本地", en: "Local" }, handler: local });
    registerCommand({ id: "app.gated", title: { zh: "门控", en: "Gated" }, when: "sessionActive", handler: gated });
    return { palette, local, gated };
  }

  it("匹配键位并执行命令", () => {
    const { local } = registerAll();
    const result = dispatchKeybinding(keyEvent({ key: "b", ctrlKey: true }), bindings, {});
    expect(result).toEqual({ command: "app.local", handled: true });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("未匹配返回 undefined", () => {
    registerAll();
    expect(dispatchKeybinding(keyEvent({ key: "z", ctrlKey: true }), bindings, {})).toBeUndefined();
  });

  it("输入框聚焦时不抢非 global 键，global 键仍然生效", () => {
    const { palette, local } = registerAll();
    const input = document.createElement("input");
    expect(dispatchKeybinding(keyEvent({ key: "b", ctrlKey: true, target: input }), bindings, {})).toBeUndefined();
    expect(local).not.toHaveBeenCalled();
    const textarea = document.createElement("textarea");
    const result = dispatchKeybinding(keyEvent({ key: "p", ctrlKey: true, shiftKey: true, target: textarea }), bindings, {});
    expect(result?.command).toBe("app.palette");
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("when 条件不满足时不执行（键位级与命令级）", () => {
    const { gated } = registerAll();
    expect(dispatchKeybinding(keyEvent({ key: "g", ctrlKey: true }), bindings, {})).toBeUndefined();
    expect(gated).not.toHaveBeenCalled();
    expect(dispatchKeybinding(keyEvent({ key: "g", ctrlKey: true }), bindings, { sessionActive: true })?.command).toBe("app.gated");
    expect(gated).toHaveBeenCalledTimes(1);
  });
});

describe("formatCombo", () => {
  it("Windows/Linux 用 Ctrl+ 组合，macOS 用符号", () => {
    expect(formatCombo("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatCombo("mod+`", false)).toBe("Ctrl+`");
    expect(formatCombo("mod+shift+p", true)).toBe("⌘⇧P");
    expect(formatCombo("f6", false)).toBe("F6");
  });
});
