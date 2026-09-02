import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { ShortcutsTable } from "../dialogs/ShortcutsTable";
import { registerBuiltinCommands, resetCommands } from "../app/commands";
import { getKeybindingOverrides, resetAllKeybindings, setKeybinding } from "../app/prefs-store";
import { loadKeybindingOverrides } from "../lib/prefs";
import { stubActions } from "./helpers/stub-actions";

beforeEach(() => {
  registerBuiltinCommands(() => stubActions());
});

afterEach(() => {
  resetCommands();
  resetAllKeybindings();
  window.localStorage.removeItem("owc-keybindings");
});

function renderTable() {
  return render(
    <I18nProvider>
      <ShortcutsTable />
    </I18nProvider>,
  );
}

// jsdom 默认 en-US：I18nProvider 走英文界面，按英文标题定位行
const SIDEBAR_TITLE = "Toggle Primary Side Bar Visibility";

describe("ShortcutsTable 自定义键位录制", () => {
  it("键位录制：组合键生效落盘并显示恢复默认；Esc 取消不写入", () => {
    // 录制 mod+alt+s：生效、落盘，表格显示新 combo 与「恢复默认」
    renderTable();
    const row = screen.getByText(SIDEBAR_TITLE, { exact: false }).closest("tr");
    expect(row).not.toBeNull();
    const comboButton = within(row as HTMLElement).getByRole("button", { name: /ctrl|⌘/i });
    fireEvent.click(comboButton);
    // 进入录制：提示文案出现
    expect(screen.getByText(/Press new combo/)).toBeInTheDocument();
    // 录制 mod+alt+s
    fireEvent.keyDown(window, { key: "s", ctrlKey: true, altKey: true });
    expect(getKeybindingOverrides()["workbench.action.toggleSidebarVisibility"]).toBe("mod+alt+s");
    expect(loadKeybindingOverrides()["workbench.action.toggleSidebarVisibility"]).toBe("mod+alt+s");
    // 表格显示新 combo 与「恢复默认」
    expect(screen.getByText("Reset")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+S", { exact: false })).toBeInTheDocument();

    // Esc 取消录制：不写入覆盖（复位上一场景的录制结果后从默认键位重录）
    cleanup();
    resetAllKeybindings();
    window.localStorage.removeItem("owc-keybindings");
    renderTable();
    const cancelRow = screen.getByText(SIDEBAR_TITLE, { exact: false }).closest("tr");
    fireEvent.click(within(cancelRow as HTMLElement).getByRole("button", { name: /ctrl|⌘/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(getKeybindingOverrides()).toEqual({});
    expect(screen.queryByText("Reset")).not.toBeInTheDocument();
  });

  it("冲突组合键拒绝保存并提示", () => {
    // 预设一个覆盖：命令面板（默认 mod+shift+p）改为 mod+b —— 与侧栏冲突
    setKeybinding("workbench.action.showCommands", "mod+b");
    renderTable();
    const row = screen.getByText(SIDEBAR_TITLE, { exact: false }).closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /ctrl|⌘/i }));
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(screen.getByText(/already used by another command/)).toBeInTheDocument();
    // 冲突未写入：覆盖表里仍只有 showCommands
    expect(loadKeybindingOverrides()).toEqual({ "workbench.action.showCommands": "mod+b" });
  });

  it("恢复默认清除该命令覆盖", () => {
    setKeybinding("workbench.action.toggleSidebarVisibility", "mod+alt+s");
    renderTable();
    fireEvent.click(screen.getByText("Reset"));
    expect(getKeybindingOverrides()).toEqual({});
  });
});
