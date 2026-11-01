import type { SessionDetail, SessionMeta } from "../sessions/types.js";

/** sessions:read 只暴露元信息白名单字段；不落出沙盒路径/setupScript 等内部配置。 */
export function publicSessionMeta(meta: SessionMeta): Record<string, unknown> {
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    provider: meta.provider,
    model: meta.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    // 活动路径叶子（消息树的当前叶子）。导出方向（dsh-sync）必须按它过滤出活动路径：
    // 分叉/重试会在消息表里留下离路径消息，只看全量 messages 会导出「用户没发生过的对话」。
    ...(meta.activeLeafId ? { activeLeafId: meta.activeLeafId } : {}),
    ...(meta.thinking ? { thinking: meta.thinking } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    ...(meta.agentMode ? { agentMode: meta.agentMode } : {}),
    ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    ...(meta.recovery ? { recovery: meta.recovery } : {}),
  };
}

/** 会话详情投影：元信息白名单 + 消息本体（分页字段按需透传）。 */
export function publicSessionDetail(detail: SessionDetail): Record<string, unknown> {
  return {
    ...publicSessionMeta(detail),
    messages: detail.messages,
    ...(detail.messageCount !== undefined ? { messageCount: detail.messageCount } : {}),
    ...(detail.hasMoreMessages !== undefined ? { hasMoreMessages: detail.hasMoreMessages } : {}),
  };
}
