export interface MessageContent {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "image";
  text?: string;
  provider?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
  mediaType?: string;
  data?: string;
  /** image 块引用形态（与 data 二选一）：uploads/|generated/ 相对路径，经 images 路由取字节。 */
  ref?: string;
  /** subagent/spawn_swarm 工具结果携带的子代理转录 id 列表 */
  subagentTaskIds?: string[];
  /** subagent/spawn_swarm 逐项终态（index 显式对应 swarm item 序号）；优先于 isError 启发式 */
  subagentTasks?: Array<{ taskId: string; index: number; status: "done" | "failed"; error?: string }>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: MessageContent[];
  createdAt: string;
}

/** @文件引用：消息发送时附带的工作区文件路径，server 在 appendMessage 前读取并注入为前置 text 块 */
export interface MessageAttachment {
  path: string;
}
