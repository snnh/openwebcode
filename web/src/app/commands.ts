/**
 * 命令体系单一模块（Phase 3 合并旧 commands/ 五文件）：
 * 注册表 + when 求值 + 默认键位集 + 全局分发 hook + 内建命令注册 + REST 覆盖审计映射。
 * - 键位串格式："mod+shift+p"，mod = Ctrl（Win/Linux）或 Cmd（macOS）。
 * - 全局分发时输入框聚焦不抢键：标记 global 的键位（面板开合、命令面板等应用级快捷键）除外。
 */
import { useEffect, useRef } from "react";
import { isBusyState } from "../lib/agent-state";
import { sessionStore } from "./session-store";
import { streamBuffer } from "../chat/stream-buffer";
import { uiStore, anyDialogOpen } from "./ui-store";
import { auxViewsStore } from "../workbench/aux-views";

// ===== 注册表 =====

export interface Command {
  id: string;
  /** 双语标题；命令 id 不翻译（守则 §8） */
  title: { zh: string; en: string };
  /**
   * when 条件：空格分隔的上下文 key，全部满足才可用；`!key` 表示取反。
   * 例："sessionActive running"、"!dialogOpen"
   */
  when?: string;
  handler(): void;
}

/** when 求值所需的上下文快照，由调用方（App/测试）提供 */
export type WhenContext = Record<string, boolean>;

export function evaluateWhen(when: string | undefined, context: WhenContext): boolean {
  if (!when) return true;
  for (const clause of when.split(/\s+/)) {
    if (!clause) continue;
    if (clause.startsWith("!")) {
      if (context[clause.slice(1)]) return false;
    } else if (!context[clause]) {
      return false;
    }
  }
  return true;
}

const commands = new Map<string, Command>();

export function registerCommand(command: Command): () => void {
  if (commands.has(command.id)) throw new Error(`duplicate command id: ${command.id}`);
  commands.set(command.id, command);
  return () => {
    // 只允许注销自己注册的条目（防止 cleanup 顺序问题误删后来注册者）
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function listCommands(context?: WhenContext): Command[] {
  const all = [...commands.values()];
  return context ? all.filter((command) => evaluateWhen(command.when, context)) : all;
}

export function runCommand(id: string, context?: WhenContext): boolean {
  const command = commands.get(id);
  if (!command || (context && !evaluateWhen(command.when, context))) return false;
  command.handler();
  return true;
}

/** 测试专用：清空注册表 */
export function resetCommands(): void {
  commands.clear();
}

// ===== 键位 =====

export interface Keybinding {
  command: string;
  key: string;
  /** 额外的 when 条件（叠加在命令自身 when 之上） */
  when?: string;
  /** 输入框/可编辑元素聚焦时仍然生效 */
  global?: boolean;
}

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta"]);

/** KeyboardEvent → 规范化键位串；纯修饰键返回 undefined */
export function comboFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | undefined {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

/** 展示用键位标签（命令面板/速查表），macOS 用符号 */
export function formatCombo(key: string, isMac: boolean): string {
  const names: Record<string, string> = isMac
    ? { mod: "⌘", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl", alt: "Alt", shift: "Shift" };
  return key
    .split("+")
    .map((part) => {
      const mapped = names[part];
      if (mapped) return mapped;
      if (part === "space") return "Space";
      if (part.startsWith("arrow")) return { arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" }[part] ?? part;
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join(isMac ? "" : "+");
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

interface DispatchResult {
  command: string;
  handled: boolean;
}

/**
 * 全局键盘分发：匹配键位 → 校验 when（键位级 + 命令级）→ 执行。
 * 返回执行的命令 id；未匹配/被 when 拦截/输入框抢键返回 undefined。
 * 组件已 preventDefault 的事件（如 Composer 的 mod+p 循环模型）不再分发——
 * window 冒泡阶段能看到 defaultPrevented，避免一键双触发。
 */
export function dispatchKeybinding(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target" | "defaultPrevented">,
  keybindings: readonly Keybinding[],
  context: WhenContext,
): DispatchResult | undefined {
  if (event.defaultPrevented) return undefined;
  const combo = comboFromEvent(event);
  if (!combo) return undefined;
  const editable = isEditableTarget(event.target ?? null);
  for (const binding of keybindings) {
    if (binding.key !== combo) continue;
    if (editable && !binding.global) return undefined;
    if (!evaluateWhen(binding.when, context)) continue;
    const command = getCommand(binding.command);
    if (!command || !evaluateWhen(command.when, context)) continue;
    command.handler();
    return { command: binding.command, handled: true };
  }
  return undefined;
}

/** 默认键位集：对齐 VSCode 习惯（Ctrl/Cmd+B 侧栏、Ctrl/Cmd+` 底部面板等） */
export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { command: "workbench.action.showCommands", key: "mod+shift+p", global: true },
  { command: "workbench.action.quickOpen", key: "mod+p", global: true, when: "sessionActive" },
  { command: "workbench.action.toggleSidebarVisibility", key: "mod+b", global: true },
  { command: "workbench.action.toggleBottomPanel", key: "mod+`", global: true },
  { command: "workbench.action.showSessionsView", key: "mod+shift+e", global: true },
  { command: "workbench.action.showFilesView", key: "mod+shift+f", global: true },
  { command: "workbench.action.showScmView", key: "mod+shift+g", global: true, when: "sessionActive" },
  { command: "workbench.action.showProblemsView", key: "mod+shift+m", global: true },
  { command: "workbench.action.openSettings", key: "mod+,", global: true },
  { command: "workbench.action.newSession", key: "mod+alt+n" },
  { command: "workbench.action.focusComposer", key: "mod+l", when: "sessionActive" },
  { command: "workbench.action.nextSession", key: "mod+pagedown", global: true },
  { command: "workbench.action.previousSession", key: "mod+pageup", global: true },
  { command: "workbench.action.keyboardShortcuts", key: "shift+?" },
  { command: "workbench.action.cycleZone", key: "f6", global: true },
  // 会话内搜索：非 global——输入框/可编辑聚焦（Composer、Monaco、搜索条自身）不抢，浏览器/编辑器原生查找照常
  { command: "workbench.action.findInConversation", key: "mod+f", when: "sessionActive !dialogOpen" },
  // 编辑器分栏：global 使 Monaco 聚焦时同样生效
  { command: "workbench.action.saveEditorFile", key: "mod+s", global: true, when: "editorOpen" },
  { command: "workbench.action.toggleEditorSplit", key: "mod+\\", global: true, when: "editorOpen" },
  // 统一 diff 视图：global 使 Monaco DiffEditor 聚焦时同样生效
  { command: "workbench.action.diffAcceptHunk", key: "mod+alt+a", global: true, when: "diffOpen" },
  { command: "workbench.action.diffRejectHunk", key: "mod+alt+r", global: true, when: "diffOpen" },
  // Esc 中断运行中任务：非 global，输入框聚焦（含 Composer 补全弹层，自行处理 Esc）不触发；
  // 浮层/编辑器/diff 打开或权限卡待决时 Esc 各有其主，不抢。
  { command: "session.abort", key: "escape", when: "running !dialogOpen !editorOpen !diffOpen !permissionPending" },
];

/**
 * 合并自定义键位覆盖到默认注册表：按 command 替换 key（保留默认的 global/when），
 * null = 解除绑定（该命令不再参与分发）。默认注册表没有的命令不引入。
 */
export function mergeKeybindings(defaults: readonly Keybinding[], overrides: Record<string, string | null>): Keybinding[] {
  const merged: Keybinding[] = [];
  for (const binding of defaults) {
    const override = overrides[binding.command];
    if (override === null) continue;
    merged.push(typeof override === "string" && override ? { ...binding, key: override } : binding);
  }
  return merged;
}

/**
 * 全局键盘分发 hook：window keydown → keybindings 匹配 → 命令执行。
 * 输入框聚焦时不抢键（标记 global 的应用级键位除外）；when 上下文每次按键实时求值。
 */
export function useGlobalKeybindings(context: WhenContext, keybindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS): void {
  // 上下文存 ref，避免每次渲染重绑监听器；按键时取最新快照
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (dispatchKeybinding(event, keybindings, contextRef.current)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}

// ===== when 上下文（从各 store 实时推导，App 无需手工拼装） =====

/** 当前会话是否运行中：agent 状态 busy 或流式缓冲仍有内容 */
export function isSessionRunning(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  if (isBusyState(sessionStore.get().agentStates[sessionId])) return true;
  return streamBuffer.blocksFor(sessionId).length > 0;
}

export function buildWhenContext(extra: { draftNonEmpty: boolean; multipleSessions: boolean }): WhenContext {
  const ui = uiStore.get();
  const aux = auxViewsStore.get();
  const sessionId = ui.sessionId;
  return {
    sessionActive: Boolean(sessionId),
    running: isSessionRunning(sessionId),
    draftNonEmpty: extra.draftNonEmpty,
    multipleSessions: extra.multipleSessions,
    dialogOpen: anyDialogOpen(ui),
    editorOpen: Boolean(aux.editor),
    diffOpen: Boolean(aux.diff),
    permissionPending: sessionStore.get().pendingPermissions.length > 0,
  };
}

// ===== 内建命令 =====

/** 命令 id 常量：keybindings、审计测试与 UI 共用 */
const COMMAND_IDS = {
  showCommands: "workbench.action.showCommands",
  quickOpen: "workbench.action.quickOpen",
  toggleSidebar: "workbench.action.toggleSidebarVisibility",
  toggleBottomPanel: "workbench.action.toggleBottomPanel",
  showSessionsView: "workbench.action.showSessionsView",
  showFilesView: "workbench.action.showFilesView",
  showScmView: "workbench.action.showScmView",
  showProblemsView: "workbench.action.showProblemsView",
  openSettings: "workbench.action.openSettings",
  newSession: "workbench.action.newSession",
  importSession: "session.import",
  deleteSession: "session.deleteCurrent",
  send: "session.send",
  abort: "session.abort",
  toggleTheme: "workbench.action.toggleTheme",
  focusComposer: "workbench.action.focusComposer",
  nextSession: "workbench.action.nextSession",
  previousSession: "workbench.action.previousSession",
  keyboardShortcuts: "workbench.action.keyboardShortcuts",
  cycleZone: "workbench.action.cycleZone",
  showNotifications: "workbench.action.showNotifications",
  saveEditorFile: "workbench.action.saveEditorFile",
  toggleEditorSplit: "workbench.action.toggleEditorSplit",
  diffAcceptHunk: "workbench.action.diffAcceptHunk",
  diffRejectHunk: "workbench.action.diffRejectHunk",
  findInConversation: "workbench.action.findInConversation",
} as const;

/** App 提供给命令的动作面；全部保持已绑定的回调，注册表不感知 React 状态 */
export interface CommandActions {
  showCommands(): void;
  quickOpen(): void;
  toggleSidebar(): void;
  toggleBottomPanel(): void;
  showView(view: "sessions" | "files" | "scm" | "problems"): void;
  openSettings(): void;
  newSession(): void;
  importSession(): void;
  deleteCurrentSession(): void;
  sendDraft(): void;
  abortRun(): void;
  toggleTheme(): void;
  focusComposer(): void;
  nextSession(): void;
  previousSession(): void;
  showKeyboardShortcuts(): void;
  cycleZone(): void;
  showNotifications(): void;
  /** 编辑器分栏：保存当前文件（走权限链）与对话/编辑器焦点切换 */
  saveEditorFile(): void;
  toggleEditorSplit(): void;
  /** 统一 diff 视图：接受/拒绝当前（首个待处理）hunk，写回走权限链 */
  diffAcceptHunk(): void;
  diffRejectHunk(): void;
  /** 会话内搜索（Ctrl+F）：打开对话搜索条（经 window 事件通知 MessageList） */
  findInConversation(): void;
}

export function registerBuiltinCommands(getActions: () => CommandActions): () => void {
  const cleanups = [
    registerCommand({ id: COMMAND_IDS.showCommands, title: { zh: "显示所有命令", en: "Show All Commands" }, handler: () => getActions().showCommands() }),
    registerCommand({ id: COMMAND_IDS.quickOpen, title: { zh: "转到文件…", en: "Go to File…" }, when: "sessionActive", handler: () => getActions().quickOpen() }),
    registerCommand({ id: COMMAND_IDS.toggleSidebar, title: { zh: "切换主侧边栏可见性", en: "Toggle Primary Side Bar Visibility" }, handler: () => getActions().toggleSidebar() }),
    registerCommand({ id: COMMAND_IDS.toggleBottomPanel, title: { zh: "切换底部面板", en: "Toggle Panel" }, handler: () => getActions().toggleBottomPanel() }),
    registerCommand({ id: COMMAND_IDS.showSessionsView, title: { zh: "显示会话视图", en: "Show Sessions View" }, handler: () => getActions().showView("sessions") }),
    registerCommand({ id: COMMAND_IDS.showFilesView, title: { zh: "显示文件视图", en: "Show Files View" }, handler: () => getActions().showView("files") }),
    registerCommand({ id: COMMAND_IDS.showScmView, title: { zh: "显示源代码管理视图", en: "Show Source Control View" }, when: "sessionActive", handler: () => getActions().showView("scm") }),
    registerCommand({ id: COMMAND_IDS.showProblemsView, title: { zh: "显示问题视图", en: "Show Problems View" }, handler: () => getActions().showView("problems") }),
    registerCommand({ id: COMMAND_IDS.openSettings, title: { zh: "打开设置", en: "Open Settings" }, handler: () => getActions().openSettings() }),
    registerCommand({ id: COMMAND_IDS.newSession, title: { zh: "新建会话", en: "New Session" }, handler: () => getActions().newSession() }),
    registerCommand({ id: COMMAND_IDS.importSession, title: { zh: "导入会话（JSONL）", en: "Import Session (JSONL)" }, handler: () => getActions().importSession() }),
    registerCommand({ id: COMMAND_IDS.deleteSession, title: { zh: "删除当前会话", en: "Delete Current Session" }, when: "sessionActive", handler: () => getActions().deleteCurrentSession() }),
    registerCommand({ id: COMMAND_IDS.send, title: { zh: "发送消息", en: "Send Message" }, when: "sessionActive draftNonEmpty", handler: () => getActions().sendDraft() }),
    registerCommand({ id: COMMAND_IDS.abort, title: { zh: "中断当前任务", en: "Stop Current Run" }, when: "sessionActive running", handler: () => getActions().abortRun() }),
    registerCommand({ id: COMMAND_IDS.toggleTheme, title: { zh: "切换深色/浅色主题", en: "Toggle Dark/Light Theme" }, handler: () => getActions().toggleTheme() }),
    registerCommand({ id: COMMAND_IDS.focusComposer, title: { zh: "聚焦输入框", en: "Focus Composer" }, when: "sessionActive", handler: () => getActions().focusComposer() }),
    registerCommand({ id: COMMAND_IDS.nextSession, title: { zh: "下一个会话", en: "Next Session" }, when: "multipleSessions", handler: () => getActions().nextSession() }),
    registerCommand({ id: COMMAND_IDS.previousSession, title: { zh: "上一个会话", en: "Previous Session" }, when: "multipleSessions", handler: () => getActions().previousSession() }),
    registerCommand({ id: COMMAND_IDS.keyboardShortcuts, title: { zh: "键盘快捷方式速查", en: "Keyboard Shortcuts Reference" }, handler: () => getActions().showKeyboardShortcuts() }),
    registerCommand({ id: COMMAND_IDS.cycleZone, title: { zh: "在界面区域间轮换焦点", en: "Cycle Focus Between Regions" }, handler: () => getActions().cycleZone() }),
    registerCommand({ id: COMMAND_IDS.showNotifications, title: { zh: "显示通知中心", en: "Show Notifications" }, handler: () => getActions().showNotifications() }),
    // 编辑器分栏：仅编辑器打开时可用
    registerCommand({ id: COMMAND_IDS.saveEditorFile, title: { zh: "保存编辑器文件", en: "Save Editor File" }, when: "editorOpen", handler: () => getActions().saveEditorFile() }),
    registerCommand({ id: COMMAND_IDS.toggleEditorSplit, title: { zh: "在对话与编辑器间切换焦点", en: "Toggle Focus Between Conversation and Editor" }, when: "editorOpen", handler: () => getActions().toggleEditorSplit() }),
    // 统一 diff 视图：仅 diff 打开时可用；接受=保留改动，拒绝=写回还原（走权限链）
    registerCommand({ id: COMMAND_IDS.diffAcceptHunk, title: { zh: "接受当前 hunk", en: "Accept Current Hunk" }, when: "diffOpen", handler: () => getActions().diffAcceptHunk() }),
    registerCommand({ id: COMMAND_IDS.diffRejectHunk, title: { zh: "拒绝当前 hunk", en: "Reject Current Hunk" }, when: "diffOpen", handler: () => getActions().diffRejectHunk() }),
    // 会话内搜索：键位层再加 "!dialogOpen"；非 global，输入框聚焦（Composer/Monaco/搜索条自身）不抢浏览器/编辑器查找
    registerCommand({ id: COMMAND_IDS.findInConversation, title: { zh: "在对话中搜索", en: "Find in Conversation" }, when: "sessionActive", handler: () => getActions().findInConversation() }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// ===== REST 动作覆盖审计（验收项） =====
// 枚举 api.ts 中用户可达的 REST 动作，并声明对应的命令 id。
// command-coverage 测试校验两侧一致：api 方法存在且命令已注册。
// 面板内部操作（上下文 pin/压缩、SCM diff、检查点等）通过面板视图命令可达，映射到打开对应视图的命令。

import type { api } from "../lib/api";

type ApiAction = keyof typeof api;

export const REST_ACTION_COMMANDS: ReadonlyArray<{ action: ApiAction; command: string }> = [
  // 会话生命周期
  { action: "sessions", command: COMMAND_IDS.showSessionsView },
  { action: "session", command: COMMAND_IDS.showSessionsView },
  { action: "createSession", command: COMMAND_IDS.newSession },
  { action: "deleteSession", command: COMMAND_IDS.deleteSession },
  { action: "importSession", command: COMMAND_IDS.importSession },
  { action: "updateSession", command: COMMAND_IDS.openSettings },
  // 重命名/置顶在会话栏完成，归入会话视图命令
  { action: "patchSession", command: COMMAND_IDS.showSessionsView },
  // 对话主链路
  { action: "sendMessage", command: COMMAND_IDS.send },
  { action: "runShell", command: COMMAND_IDS.send },
  { action: "abort", command: COMMAND_IDS.abort },
  // 文件与视图
  { action: "listFiles", command: COMMAND_IDS.showFilesView },
  { action: "readFile", command: COMMAND_IDS.quickOpen },
  { action: "writeFile", command: COMMAND_IDS.saveEditorFile },
  { action: "workspaceFiles", command: COMMAND_IDS.quickOpen },
  { action: "workspaceFileSymbols", command: COMMAND_IDS.saveEditorFile },
  { action: "completePath", command: COMMAND_IDS.quickOpen },
  { action: "latestDiagnostics", command: COMMAND_IDS.showProblemsView },
  { action: "scmStatus", command: COMMAND_IDS.showScmView },
  { action: "scmDiff", command: COMMAND_IDS.showScmView },
  { action: "context", command: COMMAND_IDS.toggleBottomPanel },
  // 后台任务列表经通知中心触达（task.finished 事件进通知流）
  { action: "tasks", command: COMMAND_IDS.showNotifications },
  // 设置与目录
  { action: "settings", command: COMMAND_IDS.openSettings },
  { action: "saveSettings", command: COMMAND_IDS.openSettings },
  { action: "models", command: COMMAND_IDS.openSettings },
];

// ===== F6 区域轮换 =====

const ZONE_ORDER = ["activity", "sidebar", "main", "bottom"] as const;

function focusZone(root: ParentNode, zone: string): void {
  const element = root.querySelector<HTMLElement>(`[data-wb-zone="${zone}"]`);
  if (!element) return;
  const focusable = element.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  (focusable ?? element).focus();
}

/** 在 activity → sidebar → main → bottom 间轮换焦点；不可见区域跳过 */
export function cycleZone(): void {
  const root = document;
  const active = document.activeElement;
  const current = active instanceof HTMLElement ? active.closest("[data-wb-zone]")?.getAttribute("data-wb-zone") : undefined;
  const startIndex = current ? (ZONE_ORDER as readonly string[]).indexOf(current) : -1;
  for (let step = 1; step <= ZONE_ORDER.length; step += 1) {
    const zone = ZONE_ORDER[(startIndex + step) % ZONE_ORDER.length]!;
    const element = root.querySelector<HTMLElement>(`[data-wb-zone="${zone}"]`);
    if (element && (element.checkVisibility?.() ?? true)) {
      focusZone(root, zone);
      return;
    }
  }
}
