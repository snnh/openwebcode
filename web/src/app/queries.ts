import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * 全部 queryKey/queryFn 的集中定义：键名与旧 App 保持一致（缓存语义不变），
 * WS 事件路由的失效（invalidate）与组件取数共用同一套键。
 */
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

export function useSessionsQuery() {
  return useQuery({ queryKey: qk.sessions, queryFn: api.sessions });
}

/** 会话详情：尾部窗口消息（limit 条）+ hasMoreMessages 供向上分页 */
export function useSessionQuery(id: string | undefined, limit = 100) {
  return useQuery({ queryKey: qk.session(id ?? ""), queryFn: () => api.session(id!, limit), enabled: Boolean(id) });
}

export function useModelsQuery() {
  return useQuery({ queryKey: qk.models, queryFn: api.models });
}

export function useProvidersQuery() {
  return useQuery({ queryKey: qk.providers, queryFn: api.providers });
}

export function useQueueQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.queue(id ?? ""), queryFn: () => api.queue(id!), enabled: Boolean(id) });
}

export function useInteractionsQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.interactions(id ?? ""), queryFn: () => api.interactions(id!), enabled: Boolean(id) });
}

export function useContextViewQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.context(id ?? ""), queryFn: () => api.context(id!), enabled: Boolean(id) });
}

export function useSkillsQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.skills(id ?? ""), queryFn: () => api.skills(id!), enabled: Boolean(id) });
}

export function useTodosQuery(id: string | undefined) {
  return useQuery({ queryKey: qk.todos(id ?? ""), queryFn: () => api.todos(id!), enabled: Boolean(id) });
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
  return useQuery({ queryKey: qk.permissions(id ?? ""), queryFn: () => api.pendingPermissions(id!), enabled: Boolean(id) });
}
