import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWhenContext,
  comboFromEvent,
  cycleZone,
  DEFAULT_KEYBINDINGS,
  dispatchKeybinding,
  evaluateWhen,
  formatCombo,
  getCommand,
  isSessionRunning,
  listCommands,
  registerBuiltinCommands,
  registerCommand,
  resetCommands,
  REST_ACTION_COMMANDS,
  runCommand,
  type Keybinding,
} from "../app/commands";
import { CommandPalette } from "../dialogs/CommandPalette";
import { chatBridge } from "../app/chat-bridge";
import { sessionMeta } from "../app/session-store";
import { uiStore } from "../app/ui-store";
import { auxViewsStore } from "../workbench/aux-views";
import { api } from "../lib/api";
import { stubActions } from "./helpers/stub-actions";

// 顶层清理合并：命令注册表重置（commands/command-palette/command-coverage/keybindings 原有）
afterEach(() => resetCommands());
// commands-context 原有清理：UI 全局状态（store/权限/辅助视图/桥/DOM）
afterEach(() => {
  uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, paletteOpen: false, quickOpen: false });
  sessionMeta.clearPermissions();
  auxViewsStore.set({});
  chatBridge.submitDraft = undefined;
  document.body.innerHTML = "";
});

describe("命令注册表", () => {
  it("注册后可按 id 查找并执行", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.a", title: { zh: "甲", en: "A" }, handler });
    expect(getCommand("test.a")?.title.en).toBe("A");
    expect(runCommand("test.a")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(runCommand("test.missing")).toBe(false);
  });

  it("重复 id 注册报错", () => {
    registerCommand({ id: "test.dup", title: { zh: "甲", en: "A" }, handler: () => undefined });
    expect(() => registerCommand({ id: "test.dup", title: { zh: "乙", en: "B" }, handler: () => undefined })).toThrow(/duplicate/);
  });

  it("注销函数移除命令；重复注销不破坏后来注册者", () => {
    const dispose = registerCommand({ id: "test.x", title: { zh: "甲", en: "A" }, handler: () => undefined });
    dispose();
    expect(getCommand("test.x")).toBeUndefined();
    registerCommand({ id: "test.x", title: { zh: "乙", en: "B" }, handler: () => undefined });
    dispose();
    expect(getCommand("test.x")?.title.en).toBe("B");
  });

  it("when 条件：全部满足可用，! 前缀取反", () => {
    expect(evaluateWhen("sessionActive running", { sessionActive: true, running: true })).toBe(true);
    expect(evaluateWhen("sessionActive running", { sessionActive: true })).toBe(false);
    expect(evaluateWhen("!running", { running: false })).toBe(true);
    expect(evaluateWhen("!running", { running: true })).toBe(false);
    expect(evaluateWhen(undefined, {})).toBe(true);
  });

  it("listCommands 按上下文过滤；runCommand 拦截不满足 when 的命令", () => {
    const handler = vi.fn();
    registerCommand({ id: "test.gated", title: { zh: "甲", en: "A" }, when: "sessionActive", handler });
    registerCommand({ id: "test.free", title: { zh: "乙", en: "B" }, handler: () => undefined });
    expect(listCommands({}).map((c) => c.id)).toEqual(["test.free"]);
    expect(listCommands({ sessionActive: true })).toHaveLength(2);
    expect(runCommand("test.gated", {})).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(runCommand("test.gated", { sessionActive: true })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ===== 以下 describe 合并自 command-palette.test.tsx =====

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

// ===== 以下 describe 合并自 command-coverage.test.ts =====

describe("命令注册表覆盖审计（§10.2：每个 REST 动作可达）", () => {
  it("审计表中的 api 动作都存在", () => {
    for (const { action } of REST_ACTION_COMMANDS) {
      expect(typeof api[action], `api.${String(action)} 应为函数`).toBe("function");
    }
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

// ===== 以下 describe 合并自 commands-context.test.ts =====

describe("buildWhenContext", () => {
  it("从 store 推导 sessionActive/running/dialogOpen/editorOpen/diffOpen/permissionPending", () => {
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false })).toMatchObject({
      sessionActive: false,
      running: false,
      dialogOpen: false,
      editorOpen: false,
      diffOpen: false,
      permissionPending: false,
    });
    uiStore.set({ sessionId: "s1" });
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false }).sessionActive).toBe(true);
    sessionMeta.setAgentState("s1", "running");
    expect(isSessionRunning("s1")).toBe(true);
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false }).running).toBe(true);
    sessionMeta.setAgentState("s1", "idle");
    expect(isSessionRunning("s1")).toBe(false);
    uiStore.set({ paletteOpen: true });
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false }).dialogOpen).toBe(true);
    uiStore.set({ paletteOpen: false });
    auxViewsStore.set({ editor: { path: "a.ts" } });
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false }).editorOpen).toBe(true);
    sessionMeta.upsertPermission({ requestId: "r1", tool: "bash", input: {} });
    expect(buildWhenContext({ draftNonEmpty: false, multipleSessions: false }).permissionPending).toBe(true);
  });

  it("draftNonEmpty/multipleSessions 由调用方显式传入", () => {
    expect(buildWhenContext({ draftNonEmpty: true, multipleSessions: true })).toMatchObject({
      draftNonEmpty: true,
      multipleSessions: true,
    });
  });
});

describe("cycleZone", () => {
  function mountShell(): void {
    document.body.innerHTML = `
      <div data-wb-zone="activity" tabindex="-1"><button data-focus="activity">a</button></div>
      <div data-wb-zone="sidebar" tabindex="-1"><button data-focus="sidebar">s</button></div>
      <div data-wb-zone="main" tabindex="-1"><button data-focus="main">m</button></div>
      <div data-wb-zone="bottom" tabindex="-1"><button data-focus="bottom">b</button></div>`;
  }

  it("从主区出发按序轮换到下一区域并聚焦其首个可聚焦元素", () => {
    mountShell();
    document.querySelector<HTMLElement>('[data-focus="main"]')!.focus();
    cycleZone();
    expect(document.activeElement).toBe(document.querySelector('[data-focus="bottom"]'));
    cycleZone();
    expect(document.activeElement).toBe(document.querySelector('[data-focus="activity"]'));
  });

  it("无区域聚焦时从首个区域开始", () => {
    mountShell();
    (document.activeElement as HTMLElement | null)?.blur?.();
    cycleZone();
    expect(document.activeElement).toBe(document.querySelector('[data-focus="activity"]'));
  });
});

describe("chatBridge 发送通路", () => {
  it("sendDraft 命令（draftNonEmpty 时）经 App 动作面 → 桥调用 ChatView 注册的 submitDraft", () => {
    const submitDraft = vi.fn();
    chatBridge.submitDraft = submitDraft;
    // App 侧动作面的真实实现（见 App.tsx actionsRef）：sendDraft 经桥路由
    const actions = stubActions({ sendDraft: () => chatBridge.submitDraft?.() });
    const cleanup = registerBuiltinCommands(() => actions);
    // runCommand 校验 when（draftNonEmpty）后执行 handler → 桥
    expect(runCommand("session.send", { sessionActive: true, draftNonEmpty: true })).toBe(true);
    expect(submitDraft).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("桥未挂时 sendDraft 是安全 no-op", () => {
    chatBridge.submitDraft = undefined;
    const actions = stubActions({ sendDraft: () => chatBridge.submitDraft?.() });
    expect(() => actions.sendDraft()).not.toThrow();
  });
});

// ===== 以下 describe 合并自 keybindings.test.ts =====

function keyEvent(init: Partial<KeyboardEvent> & { target?: EventTarget | null }): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented"> {
  return { key: "p", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false, ...init };
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

  it("组件已 preventDefault 的事件不再分发（Composer mod+p 循环模型场景）", () => {
    const { palette } = registerAll();
    const textarea = document.createElement("textarea");
    const result = dispatchKeybinding(keyEvent({ key: "p", ctrlKey: true, shiftKey: true, target: textarea, defaultPrevented: true }), bindings, {});
    expect(result).toBeUndefined();
    expect(palette).not.toHaveBeenCalled();
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

describe("Esc 中断键位（session.abort）", () => {
  // 与 builtin.ts 的注册保持一致：命令级 when 叠加键位级 when
  function registerAbort(): ReturnType<typeof vi.fn> {
    const abort = vi.fn();
    registerCommand({ id: "session.abort", title: { zh: "中断当前任务", en: "Stop Current Run" }, when: "sessionActive running", handler: abort });
    return abort;
  }

  const runningContext = { sessionActive: true, running: true };

  it("运行中按 Esc 触发中断", () => {
    const abort = registerAbort();
    const result = dispatchKeybinding(keyEvent({ key: "Escape" }), DEFAULT_KEYBINDINGS, runningContext);
    expect(result).toEqual({ command: "session.abort", handled: true });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("非运行状态不触发", () => {
    const abort = registerAbort();
    expect(dispatchKeybinding(keyEvent({ key: "Escape" }), DEFAULT_KEYBINDINGS, { sessionActive: true, running: false })).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it.each(["dialogOpen", "editorOpen", "diffOpen", "permissionPending"])("上下文 %s 打开/待决时不抢 Esc", (key) => {
    const abort = registerAbort();
    expect(dispatchKeybinding(keyEvent({ key: "Escape" }), DEFAULT_KEYBINDINGS, { ...runningContext, [key]: true })).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("输入框聚焦（Composer 自行处理 Esc/补全弹层）时不触发", () => {
    const abort = registerAbort();
    const textarea = document.createElement("textarea");
    expect(dispatchKeybinding(keyEvent({ key: "Escape", target: textarea }), DEFAULT_KEYBINDINGS, runningContext)).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });
});
