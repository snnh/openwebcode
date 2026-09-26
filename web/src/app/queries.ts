import { useEffect } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ContextView } from "../lib/contracts";
import { sessionMeta } from "./session-store";

/**
 * 全部 queryKey/queryFn 的集中定义：键名与旧 App 保持一致（缓存语义不变），
 * WS 事件路由的失效（invalidate）与组件取数共用同一套键。
 *
 * staleTime 分级（多会话来回切换的核心优化）：全局默认 staleTime=0，切回会话时
 * 会把详情/上下文/队列/交互/权限等全部重拉一遍（切一次 ≈ 6 个请求）。这些查询
 * 全部有事件驱动失效（agent.state / tool.end / interaction.* / permission.* /
 * queue.* / todos.updated / context.* / task.*），断线还有 resync.required 全量失效兜底，
 * 因此可以安全地给一个短 staleTime：窗口内切回直接用缓存（零请求），超窗后台刷新
 * 且先用缓存渲染（不闪骨架）。事件到来时依旧立即失效，实时性不受影响。
 */
/** 会话详情（尾部 100 条消息）：10s */
const SESSION_STALE_MS = 10_000;
/** 上下文视图（账本 + 压缩历史，大 payload）：15s */
const CONTEXT_STALE_MS = 15_000;
/** 运行态小查询（队列/交互/权限/todos/tasks/checkpoints）：10s */
const RUNTIME_STALE_MS = 10_000;
export const qk = {
  sessions: ["sessions"] as const,
  session: (id: string) => ["session", id] as const,
  run: (id: string) => ["run", id] as const,
  models: ["models"] as const,
  providers: ["providers"] as const,
  providerProfiles: ["provider-profiles"] as const,
  queue: (id: string) => ["queue", id] as const,
  interactions: (id: string) => ["interactions", id] as const,
  context: (id: string) => ["context", id] as const,
  skills: (id: string) => ["skills", id] as const,
  todos: (id: string) => ["todos", id] as const,
  extensions: ["extensions"] as const,
  settings: ["settings"] as const,
  updateCheck: ["update-check"] as const,
  permissions: (id: string) => ["permissions", id] as const,
  checkpoints: (id: string) => ["checkpoints", id] as const,
  tasks: (id: string) => ["tasks", id] as const,
  timeline: (id: string) => ["timeline", id] as const,
  diagnostics: (id: string) => ["diagnostics", id] as const,
  scmStatus: (id: string) => ["scm-status", id] as const,
  scmWorktrees: (id: string) => ["scm-worktrees", id] as const,
  scmDiff: (id: string) => ["scm-diff", id] as const,
  health: ["health"] as const,
};

/**
 * 会话列表。响应里的 attention（哪些会话正等着你回答）播种到 session-store，
 * 之后由 WS 事件增量维护——刷新/重连后角标也不会丢。
 */
export function useSessionsQuery() {
  const query = useQuery({ queryKey: qk.sessions, queryFn: api.sessions });
  useEffect(() => {
    if (query.data) sessionMeta.seedAttention(query.data);
  }, [query.data]);
  return query;
}

/** 会话详情：尾部窗口消息（limit 条）+ hasMoreMessages 供向上分页 */
export function useSessionQuery(id: string | undefined, limit = 100) {
  return useQuery({
    queryKey: qk.session(id ?? ""),
    queryFn: () => api.session(id!, limit),
    enabled: Boolean(id),
    staleTime: SESSION_STALE_MS,
  });
}

export function useModelsQuery() {
  return useQuery({ queryKey: qk.models, queryFn: api.models });
}

export function useProvidersQuery() {
  return useQuery({ queryKey: qk.providers, queryFn: api.providers });
}

export function useQueueQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.queue(id ?? ""), queryFn: () => api.queue(id!), enabled: Boolean(id), staleTime: RUNTIME_STALE_MS });
}

export function useInteractionsQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.interactions(id ?? ""), queryFn: () => api.interactions(id!), enabled: Boolean(id), staleTime: RUNTIME_STALE_MS });
}

/**
 * 会话上下文视图。select 窄化订阅（如 lib/context-metrics 的 selectContextMetrics）：
 * 常驻组件（顶栏/底栏/状态栏）只跟随切片变化重渲，select 结果参与 structural sharing。
 */
export function useContextViewQuery(id: string | undefined): UseQueryResult<ContextView>;
export function useContextViewQuery<T>(id: string | undefined, select: (view: ContextView) => T): UseQueryResult<T>;
export function useContextViewQuery<T>(id: string | undefined, select?: (view: ContextView) => T) {
  return useQuery({
    queryKey: qk.context(id ?? ""),
    queryFn: () => api.context(id!),
    enabled: Boolean(id),
    staleTime: CONTEXT_STALE_MS,
    ...(select ? { select } : {}),
  });
}

export function useSkillsQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.skills(id ?? ""), queryFn: () => api.skills(id!), enabled: Boolean(id) });
}

export function useTodosQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.todos(id ?? ""), queryFn: () => api.todos(id!), enabled: Boolean(id), staleTime: RUNTIME_STALE_MS });
}

export function useExtensionsQuery() {
  return useQuery({ queryKey: qk.extensions, queryFn: api.extensions });
}

/** 服务设置（与设置对话框共用缓存键；staleTime 避免重复拉取） */
export function useServerSettingsQuery() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 5 * 60_000 });
}

/** 更新检查（retry:false 避免 501 重试） */
export function useUpdateCheckQuery() {
  return useQuery({ queryKey: qk.updateCheck, queryFn: api.updateCheck, staleTime: 5 * 60_000, retry: false });
}

/** 待确认权限以服务端为准（刷新后可恢复），WS 事件只作即时补充 */
export function usePendingPermissionsQuery(id: string | undefined) {
  return useQuery({
    queryKey: qk.permissions(id ?? ""),
    queryFn: () => api.pendingPermissions(id!),
    enabled: Boolean(id),
    staleTime: RUNTIME_STALE_MS,
  });
}
