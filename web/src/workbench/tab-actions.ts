/**
 * 标签动作桥：子代理/终端标签的打开动作由 App 装配层（useSubagentTabs/useTerminalTabs 实例）注册，
 * 深层组件（子代理面板「在标签中打开」、活动栏终端入口）经此调用，避免层层透传。
 * 模块级可变对象是有意的——注册发生在 App 挂载期，调用发生在用户交互期，不存在时序竞争。
 */
export const tabActions: {
  /** 在主区标签中打开某个工具调用对应的子代理运行 */
  openSubagentTab?(toolCallId: string): void;
  /** 打开并选中当前会话的终端标签 */
  openTerminal?(): void;
} = {};
