import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { getCommand, registerCommand, resetCommands } from "../commands/registry";
import { registerBuiltinCommands, type CommandActions } from "../commands/builtin";
import { REST_ACTION_COMMANDS } from "../commands/audit";

function stubActions(): CommandActions {
  return {
    showCommands: vi.fn(), quickOpen: vi.fn(), toggleSidebar: vi.fn(), toggleBottomPanel: vi.fn(),
    showView: vi.fn(), openSettings: vi.fn(), newSession: vi.fn(), importSession: vi.fn(),
    deleteCurrentSession: vi.fn(), sendDraft: vi.fn(), abortRun: vi.fn(), toggleTheme: vi.fn(),
    focusComposer: vi.fn(), nextSession: vi.fn(), previousSession: vi.fn(),
    showKeyboardShortcuts: vi.fn(), cycleZone: vi.fn(), showNotifications: vi.fn(),
    saveEditorFile: vi.fn(), toggleEditorSplit: vi.fn(),
    diffAcceptHunk: vi.fn(), diffRejectHunk: vi.fn(),
    findInConversation: vi.fn(),
  };
}

afterEach(() => resetCommands());

describe("命令注册表覆盖审计（§10.2：每个 REST 动作可达）", () => {
  it("审计表中的 api 动作都存在", () => {
    for (const { action } of REST_ACTION_COMMANDS) {
      expect(typeof api[action], `api.${String(action)} 应为函数`).toBe("function");
    }
  });

  it("审计表中的 api 动作不重复", () => {
    const actions = REST_ACTION_COMMANDS.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("内建命令注册后覆盖审计表中全部 REST 动作", () => {
    const dispose = registerBuiltinCommands(() => stubActions());
    for (const { action, command } of REST_ACTION_COMMANDS) {
      expect(getCommand(command), `api.${String(action)} 对应命令 ${command} 应已注册`).toBeDefined();
    }
    dispose();
  });

  it("审计表引用的命令都有双语标题与 handler", () => {
    const dispose = registerBuiltinCommands(() => stubActions());
    for (const { command } of REST_ACTION_COMMANDS) {
      const registered = getCommand(command)!;
      expect(registered.title.zh).toBeTruthy();
      expect(registered.title.en).toBeTruthy();
      expect(typeof registered.handler).toBe("function");
    }
    dispose();
  });
});

describe("内建命令注册", () => {
  it("重复注册同一批内建命令报 duplicate（防止双重挂载）", () => {
    const dispose = registerBuiltinCommands(() => stubActions());
    expect(() => registerBuiltinCommands(() => stubActions())).toThrow(/duplicate/);
    dispose();
  });

  it("handler 每次取最新 actions（惰性求值）", () => {
    const first = stubActions();
    const second = stubActions();
    let current = first;
    const dispose = registerBuiltinCommands(() => current);
    current = second;
    getCommand("workbench.action.showCommands")!.handler();
    expect(first.showCommands).not.toHaveBeenCalled();
    expect(second.showCommands).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("注册表可与普通命令共存", () => {
    const dispose = registerBuiltinCommands(() => stubActions());
    registerCommand({ id: "ext.demo", title: { zh: "演示", en: "Demo" }, handler: () => undefined });
    expect(getCommand("ext.demo")).toBeDefined();
    dispose();
  });
});
