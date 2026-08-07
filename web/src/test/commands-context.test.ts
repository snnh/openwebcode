import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWhenContext, cycleZone, isSessionRunning, registerBuiltinCommands, resetCommands, runCommand } from "../app/commands";
import { uiStore } from "../app/ui-store";
import { sessionMeta } from "../app/session-store";
import { auxViewsStore } from "../workbench/aux-views";
import { chatBridge } from "../app/chat-bridge";
import { stubActions } from "./helpers/stub-actions";

afterEach(() => {
  uiStore.set({ sessionId: undefined, newSessionOpen: false, settingsOpen: false, paletteOpen: false, quickOpen: false });
  sessionMeta.clearPermissions();
  auxViewsStore.set({});
  chatBridge.submitDraft = undefined;
  resetCommands();
  document.body.innerHTML = "";
});

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
