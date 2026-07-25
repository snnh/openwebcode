/**
 * 内建命令注册（0.4.0 Phase 5a）：把 App 的现有操作逐一登记进注册表。
 * App 挂载时调用 registerBuiltinCommands(actions)，卸载时用返回的清理函数注销。
 */
import { registerCommand } from "./registry";

/** 命令 id 常量：keybindings、审计测试与 UI 共用 */
export const COMMAND_IDS = {
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
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
