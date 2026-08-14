import type { ChatMessage } from "./message";

/** GET /api/sessions/:id/subagents/:taskId 响应：runSubAgent 落盘的子代理转录 */
export interface SubagentTranscript {
  id: string;
  prompt: string;
  agent?: string;
  startedAt: string;
  turns: number;
  toolsUsed: string[];
  conclusion: string;
  messages: ChatMessage[];
}

/** swarm 批量派生中的单项序号（WS 事件与实时状态共用） */
export interface SubagentSwarmRef {
  index: number;
  total: number;
}

/** WS 事件 subagent.started 的 payload */
export interface SubagentStartedEvent {
  toolCallId: string;
  taskId: string;
  prompt: string;
  agent?: string;
  swarm?: SubagentSwarmRef;
}

/** WS 事件 subagent.progress 的 payload（仅元数据：轮次与已用工具，不含文本） */
export interface SubagentProgressEvent {
  toolCallId: string;
  taskId: string;
  turns: number;
  toolsUsed: string[];
  swarm?: SubagentSwarmRef;
}

/** WS 事件 subagent.finished 的 payload */
export interface SubagentFinishedEvent {
  toolCallId: string;
  taskId: string;
  status: "done" | "failed";
  turns?: number;
  toolsUsed?: string[];
  error?: string;
  swarm?: SubagentSwarmRef;
}

/** 客户端按会话维护的子代理运行状态（实时事件驱动，终态保留供子代理面板展示会话级历史；消息轨道卡片与面板共用） */
export interface LiveSubagentRun {
  taskId: string;
  toolCallId: string;
  prompt: string;
  agent?: string;
  swarm?: SubagentSwarmRef;
  status: "running" | "done" | "failed";
  turns: number;
  toolsUsed: string[];
  error?: string;
}

/** GET /api/agents 响应项：内置与自定义子代理类型 */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

/** GET /api/agents 响应 */
export interface AgentListResponse {
  agents: AgentInfo[];
}

/** POST /api/sessions/:id/subagents 202 响应（手动启动子代理）；toolCallId = "manual-" + taskId */
export interface StartSubagentResponse {
  taskId: string;
  toolCallId: string;
}
