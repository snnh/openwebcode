import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type {
  AgentErrorPayload, ChatMessage, ContextUsage, ExtensionInfo,
  InteractionRequest, LiveSubagentRun, QueueItem, SessionDetail,
} from "../lib/contracts";
import type { ContextWindowInfo } from "../lib/context-window";
import type { StreamBlock } from "./stream-buffer";
import type { CompactionMarker } from "../lib/compaction";
import type { LiveActivityInfo } from "../app/live-store";
import type { DiffSpec } from "../components/editor/DiffPane";
import type { PendingPermission } from "../app/session-store";

/**
 * 聊天主链路的跨组件契约（Phase 1 重写的接缝）：
 * 各组件 props 全部固定在本文件，并行实现/替换实现时不得偏离。
 * 共享回调经 ChatActionsContext 下发（消灭层层透传）；数据类仍走 props（保持 memo 语义明确）。
 */

export type { StreamBlock, DiffSpec };

/** 命令体系经 window 事件桥接打开会话内搜索（与旧 CONVERSATION_SEARCH_EVENT 同名） */
export const CONVERSATION_SEARCH_EVENT = "owc:open-conversation-search";

/** 消息卡片/子组件共用的动作面：ChatView 提供，MessageCard 等经 useChatActions() 消费 */
export interface ChatActions {
  sessionId: string;
  running: boolean;
  /** content-lens 官方扩展启用时提供（消息翻译/解释入口） */
  contentLens?: ExtensionInfo;
  onNotice(text: string, kind?: "info" | "error"): void;
  /** write_file/edit_file 工具卡的文件变化在统一 diff 视图打开 */
  onOpenDiff(spec: DiffSpec): void;
  /** 产出文件行/工具卡的文件路径在编辑器打开（工作台装配提供；未提供时降级为静态展示） */
  onOpenFile?(path: string): void;
  /** shell 快捷命令结果卡的「发给 agent」 */
  onSendToAgent(cmd: string, output: string): void;
  /** 会话树操作：编辑重发 / 重新生成 / 分叉（仅 user 消息卡片） */
  onEditMessage(message: ChatMessage): void;
  onRegenerate(message: ChatMessage): void;
  onFork(message: ChatMessage): void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) throw new Error("useChatActions 必须在 ChatActionsContext.Provider 内使用");
  return actions;
}

/** 单条消息卡片（user/assistant/tool/subagent 运行卡统一入口） */
export interface MessageCardProps {
  message: ChatMessage;
  /** 轮次编号（user 消息开启一轮），驱动轮次深浅底色 turn-even/odd */
  turn: number;
  /** 全会话工具结果配对表：toolCallId → isError */
  toolResults: Record<string, boolean>;
  /** 该消息 spawn 的实时子代理运行（无则 undefined） */
  liveSubagents?: LiveSubagentRun[];
  /** shell 快捷命令（`!cmd`）结果卡的原始命令文本：由列表按序配对前一条 user 消息得出，有才渲染「发给 agent」按钮 */
  shellCmd?: string;
}

/** 过程消息连续段的折叠组（会话空闲时；原生 <details> 语义，内容常驻 DOM 可被搜索） */
export interface ProcessFoldProps {
  toolCalls: number;
  failed: boolean;
  children: ReactNode;
}

/** 流式区：text/thinking 原位渲染，相邻 tool（≥2）实时聚合为展开的工具调用组 */
export interface LiveStreamProps {
  blocks: StreamBlock[];
  /** 轮次编号（延续最后一条历史消息的轮次底色） */
  turn: number;
}

export interface PermissionCardProps {
  permission: PendingPermission;
  onDone(requestId: string): void;
  onError?(message: string): void;
}

export interface InteractionCardProps {
  item: InteractionRequest;
  onRespond(answer: unknown): void;
}

export interface PlanApprovalCardProps {
  item: InteractionRequest;
  onRespond(answer: unknown): void;
}

/** 本轮执行失败的持久可见错误卡（含分类提示、重试/打开模型设置动作） */
export interface RunErrorCardProps {
  error: AgentErrorPayload;
  onRetryRun?(): void;
  retryPending?: boolean;
}

/** 实时活动条（agent.state + 未结束工具）：文档流内占位，不覆盖消息 */
export interface LiveActivityBarProps {
  activity: LiveActivityInfo;
}

export interface SteeringQueueProps {
  items: QueueItem[];
  onRemove(itemId: string): void;
}

/** 会话内搜索条（Ctrl+F）：匹配数据驱动，高亮由 MessageList 布局效果统一施加 */
export interface SearchBarProps {
  query: string;
  onQueryChange(value: string): void;
  current: number;
  total: number;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
  /** 有未加载的更早消息时提示「仅搜索已加载内容」 */
  loadedOnly?: boolean;
  /** 递增触发输入框聚焦（已打开时重复触发命令） */
  focusSignal?: number;
}

/** 聊天滚动区：消息列表 + 流式区 + 权限卡 + 活动条 + 搜索 + 分页哨兵 + 回到底部 */
export interface MessageListProps {
  /** 显示用会话（已合并分页加载的更早消息） */
  session: SessionDetail;
  /** 上下文清空分隔线位置（ledger.cleared；uptoMessageId 为 /clear 时刻最后一条活动路径消息 id） */
  cleared?: { uptoIndex: number; at: string; uptoMessageId?: string };
  /** 压缩检查点标记（实时事件 + 账本还原的合并结果；缺省不渲染检查点行） */
  compactions?: CompactionMarker[];
  hasMoreMessages: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  streamBlocks: StreamBlock[];
  runError?: AgentErrorPayload;
  /** 合并后的待决权限（服务端列表 + WS 即时卡） */
  permissions: PendingPermission[];
  liveActivity?: LiveActivityInfo;
  liveSubagents: Record<string, LiveSubagentRun>;
  running: boolean;
  /** 对话面板可见性（标签互斥隐藏时暂停吸底，恢复可见重新贴底） */
  visible?: boolean;
  onRetryRun?(): void;
  retryPending?: boolean;
  onPermissionDone(requestId: string): void;
}

/** 会话头（旧 JobHeader 并入）：标题/模式/模型/成本/上下文水位/操作 */
export interface SessionHeaderProps {
  session: SessionDetail;
  agentState?: string;
  costSummary?: {
    tokens: number;
    costLabel: string;
    tokenBudget?: number | null;
    paused: boolean;
    /** 未定价 tokens（>0 时成本不完整，顶栏标 * 并在 title 注明）；缺省视为 0 */
    unpricedTokens?: number;
  };
  windowUsage?: ContextWindowInfo;
  latestUsage?: ContextUsage;
  running: boolean;
  checkpointPending?: boolean;
  onAbort(): void;
  onConfig(body: Record<string, unknown>): void;
  onCreateCheckpoint(): void;
  /** 移动端：打开左上角导航菜单 */
  onOpenNavMenu?(): void;
}

/** Composer 编辑重发态（进入时把目标 user 消息文本灌入输入框） */
export interface EditingMessage {
  messageId: string;
  hadAttachments: boolean;
}

export interface ComposerProps {
  session: SessionDetail;
  running: boolean;
  /** 发送（behavior 缺省由 Composer 内按 running 推导：运行中 steer，否则 start） */
  onSend(behavior?: "start" | "steer" | "follow_up"): void;
  onConfig(body: Record<string, unknown>): void;
  editingMessage?: EditingMessage;
  onCancelEdit(): void;
}
