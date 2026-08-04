/**
 * keybindings 注册表与默认集（0.4.0 Phase 5a）。
 * - 键位串格式："mod+shift+p"，mod = Ctrl（Win/Linux）或 Cmd（macOS）。
 * - 全局分发时输入框聚焦不抢键：标记 global 的键位（面板开合、命令面板等
 *   应用级快捷键）除外，与 VSCode 行为一致。
 */
import { evaluateWhen, getCommand, type WhenContext } from "./registry";

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

export interface DispatchResult {
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
  // 编辑器分栏（0.5.0 Phase 1a）：global 使 Monaco 聚焦时同样生效
  { command: "workbench.action.saveEditorFile", key: "mod+s", global: true, when: "editorOpen" },
  { command: "workbench.action.toggleEditorSplit", key: "mod+\\", global: true, when: "editorOpen" },
  // 统一 diff 视图（0.5.0 Phase 1b）：global 使 Monaco DiffEditor 聚焦时同样生效
  { command: "workbench.action.diffAcceptHunk", key: "mod+alt+a", global: true, when: "diffOpen" },
  { command: "workbench.action.diffRejectHunk", key: "mod+alt+r", global: true, when: "diffOpen" },
  // Esc 中断运行中任务：非 global，输入框聚焦（含 Composer 补全弹层，自行处理 Esc）不触发；
  // 浮层/编辑器/diff 打开或权限卡待决时 Esc 各有其主，不抢。
  { command: "session.abort", key: "escape", when: "running !dialogOpen !editorOpen !diffOpen !permissionPending" },
];
