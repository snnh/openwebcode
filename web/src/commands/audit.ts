/**
 * 命令覆盖审计（0.4.0 Phase 5a 验收项）：
 * 枚举 api.ts 中用户可达的 REST 动作，并声明对应的命令 id。
 * command-coverage.test.ts 校验两侧一致：api 方法存在且命令已注册。
 * 面板内部操作（上下文 pin/压缩、SCM diff、检查点等）通过面板视图命令可达，
 * 映射到打开对应视图的命令。
 */
import type { api } from "../lib/api";
import { COMMAND_IDS } from "./builtin";

type ApiAction = keyof typeof api;

export const REST_ACTION_COMMANDS: ReadonlyArray<{ action: ApiAction; command: string }> = [
  // 会话生命周期
  { action: "sessions", command: COMMAND_IDS.showSessionsView },
  { action: "session", command: COMMAND_IDS.showSessionsView },
  { action: "createSession", command: COMMAND_IDS.newSession },
  { action: "deleteSession", command: COMMAND_IDS.deleteSession },
  { action: "importSession", command: COMMAND_IDS.importSession },
  { action: "updateSession", command: COMMAND_IDS.openSettings },
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
