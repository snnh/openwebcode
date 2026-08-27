import type { AgentListResponse, AgentRun, BackgroundTaskInfo, CatalogSyncStatus, Checkpoint, CompletePathResponse, ContextView, CostReport, CronJobInfo, ExtensionInfo, FileEntry, ManagedWorkspaceCapability, ManagedWorkspaceSyncPreview, ManagedWorkspaceSyncResult, MessageAttachment, MessagesPage, ModelProfile, PendingPermission, PersonaDetail, PersonaSummary, PricingDocument, ProviderConcurrencyStats, ProviderConnectionTestResult, ProviderProfilesView, SandboxCapabilities, SandboxMode, SandboxNetwork, Session, SessionDetail, SessionSandboxStatus, SettingsView, SettingValue, SkillInfo, SnapshotCapabilityInfo, StartSubagentResponse, SubagentTranscript, SyncResult, TodoItem, WebCapability } from "./contracts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/** 任意非 /api/auth/* 请求 401 时通知（登录页兜底：服务端重启票据失效等场景） */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

async function request<T>(path: string, init?: RequestInit, opts?: { broadcastUnauthorized?: boolean }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  // 仅有 body 时声明 content-type，避免 Fastify 对空 body 的 POST 报校验错误
  if (init?.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; code?: string };
    if (response.status === 401 && !path.startsWith("/api/auth/") && opts?.broadcastUnauthorized !== false) {
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(response.status, body.error ?? response.statusText, body.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Encode a browser File without exposing its data-URL prefix to the API. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
    reader.onabort = () => reject(reader.error ?? new Error("File read aborted"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to encode file as base64"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Unable to encode file as base64"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const api = {
  sessions: () => request<Session[]>("/api/sessions"),
  health: () => request<{ status: string }>("/api/health"),
  // TOTP 全局登录认证（提交⑥）
  authStatus: () => request<import("./contracts").AuthStatus>("/api/auth/status"),
  totpSetup: () => request<import("./contracts").TotpSetupResponse>("/api/auth/totp/setup", { method: "POST" }),
  totpConfirm: (code: string) => request<import("./contracts").TotpConfirmResponse>("/api/auth/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  totpDisable: (code: string) => request<{ ok: true }>("/api/auth/totp/disable", { method: "POST", body: JSON.stringify({ code }) }),
  login: (code: string) => request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ code }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  // 远程访问（局域网/移动端）：令牌状态、一键访问链接与自动生成令牌的再生成
  remoteAccess: () => request<import("./contracts").RemoteAccessInfo>("/api/remote-access"),
  regenerateToken: () => request<import("./contracts").RegenerateTokenResponse>("/api/remote-access/regenerate-token", { method: "POST" }),
  version: () => request<import("./contracts").VersionInfo>("/api/version"),
  updateCheck: () => request<import("./contracts").UpdateCheckResponse>("/api/update-check"),
  refreshUpdateCheck: () => request<import("./contracts").UpdateCheckResponse>("/api/update-check/refresh", { method: "POST" }),
  // 在线更新（应用内升级）：POST 202 返回初始状态；400=已是最新/平台不支持，409=已有更新进行中，501=未配置
  updateApplyStatus: () => request<{ state: import("./contracts").UpdateApplyState | null }>("/api/update/apply"),
  updateApplyStart: () => request<{ state: import("./contracts").UpdateApplyState }>("/api/update/apply", { method: "POST" }),
  promptOverride: (opts?: { cwd?: string; scope?: "global" | "project" }) => {
    const params = new URLSearchParams();
    if (opts?.scope) params.set("scope", opts.scope);
    if (opts?.cwd) params.set("cwd", opts.cwd);
    const query = params.toString();
    return request<import("./contracts").PromptOverrideView>(`/api/prompt${query ? `?${query}` : ""}`);
  },
  savePromptOverride: (body: { scope?: "global" | "project"; cwd?: string; identityOverride?: string | null; baseOverride?: string | null; customAppend?: string | null; subAgentAppend?: string | null; initOverride?: string | null; compactOverviewOverride?: string | null; compactToolcallsOverride?: string | null }) =>
    request<{ ok: boolean }>("/api/prompt", { method: "PUT", body: JSON.stringify(body) }),
  providerStats: () => request<Record<string, ProviderConcurrencyStats>>("/api/providers/stats"),
  rebuildIndex: (sessionId: string) => request<{ accepted: boolean; jobId: string }>("/api/workspaces/index/rebuild", { method: "POST", body: JSON.stringify({ sessionId }) }),
  session: (id: string, limit?: number) => request<SessionDetail>(`/api/sessions/${id}${limit ? `?limit=${limit}` : ""}`),
  messagesPage: (id: string, before: string, limit?: number) => request<MessagesPage>(`/api/sessions/${id}/messages?before=${encodeURIComponent(before)}${limit ? `&limit=${limit}` : ""}`),
  run: (id: string) => request<AgentRun>(`/api/sessions/${id}/run`),
  createSession: (body: { cwd?: string; kind?: "local"; provider: string; model: string; title?: string; agentMode?: "plan" | "code" | "goal"; sandboxMode?: SandboxMode; network?: SandboxNetwork; setupScript?: string; workspaceMode?: "managed"; bindLinks?: { virtPath: string; backingPath: string; readOnly?: boolean }[]; toolsAllow?: string[]; toolsDeny?: string[]; fallbackModels?: { provider: string; model: string }[] }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  sandboxCapabilities: () => request<SandboxCapabilities>("/api/sandbox/capabilities"),
  sessionSandboxStatus: (sessionId: string) => request<SessionSandboxStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/sandbox-status`),
  managedWorkspaceCapability: () => request<ManagedWorkspaceCapability>("/api/managed-workspace/capability"),
  workspaceSyncPreview: (id: string) => request<ManagedWorkspaceSyncPreview>(`/api/sessions/${encodeURIComponent(id)}/workspace/sync-preview`),
  syncWorkspace: (id: string, body: { confirm: true; previewFingerprint: string; overwriteConflicts?: boolean }) =>
    request<ManagedWorkspaceSyncResult>(`/api/sessions/${encodeURIComponent(id)}/workspace/sync`, { method: "POST", body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  // 会话显示属性：title ≤120 字符（空串清除覆盖回落派生标题），pinned 控制列表置顶
  patchSession: (id: string, body: { title?: string; pinned?: boolean }) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  sendMessage: (id: string, content: string, images?: Array<{ mediaType: string; data: string }>, attachments?: MessageAttachment[], behavior: "start" | "steer" | "follow_up" = "start") =>
    request<{ accepted: boolean; queued?: boolean; position?: number; compacted?: boolean; result?: { changed: boolean; mode: string; reason?: string }; behavior?: string; reused?: boolean }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content, behavior, ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) }) }),
  interactions: (id: string) => request<import("./contracts").InteractionRequest[]>(`/api/sessions/${id}/interactions`),
  timeline: (id: string) => request<import("./contracts").SessionTimeline>(`/api/sessions/${id}/timeline`),
  // 会话树：检出到任意节点（409=运行中）；分叉为新会话（运行中允许）；重试=检出到父节点并可附带编辑后的用户消息重启（202）
  checkoutSession: (id: string, messageId: string) =>
    request<{ ok: boolean; activeLeafId: string }>(`/api/sessions/${encodeURIComponent(id)}/checkout`, { method: "POST", body: JSON.stringify({ messageId }) }),
  forkSession: (id: string, body: { messageId?: string } = {}) =>
    request<{ sessionId: string }>(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", body: JSON.stringify(body) }),
  retryMessage: (id: string, messageId: string, body: { editedContent?: string }) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST", body: JSON.stringify(body) }),
  queue: (id: string) => request<import("./contracts").QueueItem[]>(`/api/sessions/${id}/queue`),
  updateQueue: (id: string, itemId: string, body: { content?: string; kind?: "steer" | "follow_up" }) => request<import("./contracts").QueueItem>(`/api/sessions/${id}/queue/${itemId}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeQueue: (id: string, itemId: string) => request<void>(`/api/sessions/${id}/queue/${itemId}`, { method: "DELETE" }),
  respondInteraction: (id: string, requestId: string, answer: unknown) => request<import("./contracts").InteractionRequest>(`/api/sessions/${id}/interactions/${requestId}/respond`, { method: "POST", body: JSON.stringify({ answer }) }),
  uploadPdf: async (sessionId: string, file: File): Promise<{ path: string }> => {
    const data = await readFileAsBase64(file);
    return request<{ path: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/pdf-upload`, {
      method: "POST",
      body: JSON.stringify({ name: file.name, data }),
    });
  },
  browseRoots: () => request<{ roots: string[] }>("/api/browse/roots"),
  browseDirectory: (dirPath: string) =>
    request<{ path: string; parent: string | null; entries: { name: string; isDir: boolean; isSymlink: boolean }[] }>(
      `/api/browse?path=${encodeURIComponent(dirPath)}`,
    ),
  completePath: (id: string, q: string) =>
    request<CompletePathResponse>(`/api/sessions/${id}/complete-path?q=${encodeURIComponent(q)}`),
  // @ 补全优先走索引缓存（§5.2）；索引未建/未启用时 409/501，由调用方回退 completePath
  workspaceFiles: (sessionId: string, q: string, limit = 15) =>
    request<import("./contracts").WorkspaceFilesResponse>(`/api/workspaces/files?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}&limit=${limit}`),
  workspaceSymbols: (sessionId: string, q: string, limit = 8) =>
    request<import("./contracts").WorkspaceSymbolsResponse>(`/api/workspaces/symbols?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}&limit=${limit}`),
  abort: (id: string) => request<{ accepted: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  runShell: (id: string, cmd: string) =>
    request<{ accepted: boolean }>(`/api/sessions/${id}/shell`, { method: "POST", body: JSON.stringify({ cmd }) }),
  respondPermission: (id: string, body: { requestId: string; decision: "allow" | "allow_always" | "deny"; reason?: string }) =>
    request<{ accepted: boolean }>(`/api/sessions/${id}/permissions/respond`, { method: "POST", body: JSON.stringify(body) }),
  pendingPermissions: (id: string) => request<PendingPermission[]>(`/api/sessions/${id}/permissions`),
  todos: (id: string) => request<TodoItem[]>(`/api/sessions/${id}/todos`),
  cronJobs: (id: string) => request<CronJobInfo[]>(`/api/sessions/${id}/cron`),
  createCronJob: (id: string, body: { cron: string; prompt: string; recurring: boolean }) =>
    request<CronJobInfo>(`/api/sessions/${id}/cron`, { method: "POST", body: JSON.stringify(body) }),
  deleteCronJob: (id: string, jobId: string) =>
    request<void>(`/api/sessions/${id}/cron/${jobId}`, { method: "DELETE" }),
  updateSession: (id: string, body: Record<string, unknown>) =>
    request<Session>(`/api/sessions/${id}/config`, { method: "PUT", body: JSON.stringify(body) }),
  context: (id: string) => request<ContextView>(`/api/sessions/${id}/context`),
  updateBudget: (id: string, body: { maxSessionTokens?: number | null; maxSessionCost?: { amount: string; currency?: string } | null }) =>
    request<void>(`/api/sessions/${id}/context/budget`, { method: "PUT", body: JSON.stringify(body) }),
  restoreContext: (id: string, messageId: string) =>
    request<void>(`/api/sessions/${id}/context/restore`, { method: "POST", body: JSON.stringify({ messageId }) }),
  updateContextPolicy: (id: string, body: Partial<NonNullable<ContextView["ledger"]["policy"]>>) =>
    request<ContextView["ledger"]>(`/api/sessions/${id}/context/policy`, { method: "PUT", body: JSON.stringify(body) }),
  updateContextSelection: (id: string, body: { pins?: string[]; excludes?: string[] }) =>
    request<{ pins: string[]; excludes: string[] }>(`/api/sessions/${id}/context/selection`, { method: "PUT", body: JSON.stringify(body) }),
  compactContext: (id: string, mode: "toolcalls" | "overview") =>
    request<{ changed: boolean; mode: string; reason?: string }>(`/api/sessions/${id}/compact`, { method: "POST", body: JSON.stringify({ mode }) }),
  mutateContextEntry: (id: string, messageId: string, action: "evict" | "pin" | "unpin") =>
    request<ContextView["ledger"]>(`/api/sessions/${id}/context/entries/${encodeURIComponent(messageId)}`, { method: "POST", body: JSON.stringify({ action }) }),
  contextArtifact: (id: string, artifactId: string) =>
    request<{ content: string }>(`/api/sessions/${id}/context/artifacts/${encodeURIComponent(artifactId)}`),
  checkpoints: (id: string) => request<Checkpoint[]>(`/api/sessions/${id}/checkpoints`),
  snapshotCapability: (id: string) => request<SnapshotCapabilityInfo>(`/api/sessions/${id}/snapshot-capability`),
  createCheckpoint: (id: string, label?: string) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ label }) }),
  deleteCheckpoint: (id: string, checkpointId: string) =>
    request<void>(`/api/sessions/${id}/checkpoints/${checkpointId}`, { method: "DELETE" }),
  restoreCheckpoint: (id: string, checkpointId: string, filesOnly = false) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints/${checkpointId}/restore`, { method: "POST", body: JSON.stringify({ confirm: true, filesOnly }) }),
  checkpointDiff: (id: string, checkpointId: string) =>
    request<{ diff: string }>(`/api/sessions/${id}/checkpoints/${checkpointId}/diff`),
  providers: () => request<string[]>("/api/providers"),
  providerProfiles: () => request<ProviderProfilesView>("/api/provider-profiles"),
  createModelProvider: (body: Record<string, unknown>) => request<ProviderProfilesView>("/api/provider-profiles/models", { method: "POST", body: JSON.stringify(body) }),
  saveModelProvider: (id: string, body: Record<string, unknown>) => request<ProviderProfilesView>(`/api/provider-profiles/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteModelProvider: (id: string) => request<ProviderProfilesView>(`/api/provider-profiles/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testModelProvider: (body: Record<string, unknown>) => request<ProviderConnectionTestResult>("/api/provider-profiles/test", { method: "POST", body: JSON.stringify(body) }),
  createWebProvider: (body: Record<string, unknown>) => request<ProviderProfilesView>("/api/provider-profiles/web", { method: "POST", body: JSON.stringify(body) }),
  saveWebProvider: (id: string, body: Record<string, unknown>) => request<ProviderProfilesView>(`/api/provider-profiles/web/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteWebProvider: (id: string) => request<ProviderProfilesView>(`/api/provider-profiles/web/${encodeURIComponent(id)}`, { method: "DELETE" }),
  selectWebProvider: (capability: WebCapability, id: string | null) => request<ProviderProfilesView>(`/api/provider-profiles/web-active/${capability}`, { method: "PUT", body: JSON.stringify({ id }) }),
  models: () => request<ModelProfile[]>("/api/models"),
  modelSyncStatus: () => request<CatalogSyncStatus>("/api/models/sync-status"),
  refreshModels: () => request<{ added: number; total: number; errors: string[] }>("/api/models/refresh", { method: "POST" }),
  syncModels: () => request<SyncResult>("/api/models/sync", { method: "POST" }),
  saveModel: (id: string, body: { provider?: string; originalProvider?: string; displayName?: string; contextWindow?: number; capabilities?: ModelProfile["capabilities"] }) =>
    request<ModelProfile>(`/api/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteModel: (id: string, provider?: string) => request<void>(`/api/models/${encodeURIComponent(id)}${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { method: "DELETE" }),
  modelPricing: () => request<PricingDocument>("/api/model-pricing"),
  syncModelPricing: () => request<SyncResult>("/api/model-pricing/sync", { method: "POST" }),
  saveModelPricing: (document: PricingDocument) =>
    request<PricingDocument>("/api/model-pricing", { method: "PUT", body: JSON.stringify(document) }),
  listFiles: (id: string, path = ".") => request<{ entries: FileEntry[]; truncated: boolean }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
  // 可选 offset/limit 按行分页（阶段 2 加载更多）；默认时服务端按默认上限截断
  readFile: (id: string, path: string, opts: { offset?: number; limit?: number } = {}) => {
    const params = new URLSearchParams({ path });
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    return request<{ content: string; encoding: string; truncated: boolean; revision: string; totalLines?: number }>(`/api/sessions/${id}/files/content?${params.toString()}`);
  },
  // 图片等二进制预览（阶段 2）：直接作为 <img> src 使用，不走 JSON
  fileRawUrl: (id: string, path: string) => `/api/sessions/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(path)}`,
  // 编辑器保存（0.5.0 Phase 1a）：走 server 端 write_file 同一权限链与 plan 只读门禁；
  // 审批挂起期间请求保持打开，403=权限/plan 拒绝
  writeFile: (id: string, path: string, content: string, expectedRevision: string) =>
    request<{ ok: true; revision: string }>(`/api/sessions/${id}/files/content`, { method: "PUT", body: JSON.stringify({ path, content, expectedRevision }) }),
  // 编辑器面包屑符号（0.5.0 Phase 1a）：按文件取符号；索引未启用/未建时 501/409，调用方按无符号降级
  workspaceFileSymbols: (sessionId: string, file: string) =>
    request<import("./contracts").WorkspaceSymbolsResponse>(`/api/workspaces/symbols?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(file)}`),
  // 最近一次诊断结果（Phase 3）；无记录时服务端 404，由调用方按空态处理
  latestDiagnostics: (id: string) => request<import("./contracts").DiagnosticSet>(`/api/sessions/${encodeURIComponent(id)}/diagnostics/latest`),
  // SCM（Phase 4）：只读 status/diff + worktree 管理；提交不走 REST，由面板下发 agent 消息走权限链
  scmStatus: (id: string) => request<import("./contracts").ScmStatus>(`/api/sessions/${encodeURIComponent(id)}/git/status`),
  scmDiff: (id: string, opts: { staged?: boolean; base?: string; file?: string } = {}) => {
    const params = new URLSearchParams();
    params.set("staged", opts.staged ? "true" : "false");
    if (opts.base) params.set("base", opts.base);
    if (opts.file) params.set("file", opts.file);
    return request<import("./contracts").ScmDiff>(`/api/sessions/${encodeURIComponent(id)}/git/diff?${params.toString()}`);
  },
  scmWorktrees: async (id: string) => {
    // server 返回 { worktrees: WorktreeEntry[] }
    const response = await request<{ worktrees: import("./contracts").ScmWorktree[] }>(`/api/sessions/${encodeURIComponent(id)}/git/worktrees`);
    return response.worktrees;
  },
  scmCreateWorktree: (id: string, body: { name?: string; branch?: string }) =>
    request<import("./contracts").ScmWorktree>(`/api/sessions/${encodeURIComponent(id)}/git/worktrees`, { method: "POST", body: JSON.stringify(body) }),
  scmDeleteWorktree: (id: string, name: string, opts: { force?: boolean } = {}) =>
    request<{ removed: true; name: string }>(`/api/sessions/${encodeURIComponent(id)}/git/worktrees/${encodeURIComponent(name)}${opts.force ? "?force=true" : ""}`, { method: "DELETE" }),
  // SCM 写操作（阶段 2）：stage/unstage/discard 由面板直接调用；成功后服务端发 scm.updated，前端同步 invalidate
  scmStage: (id: string, files: string[]) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/git/stage`, { method: "POST", body: JSON.stringify({ files }) }),
  scmUnstage: (id: string, files: string[]) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/git/unstage`, { method: "POST", body: JSON.stringify({ files }) }),
  // discard 含未跟踪文件时服务端要求 force=true（默认 400）；tracked 放弃传 force=false
  scmDiscard: (id: string, files: string[], force = false) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/git/discard`, { method: "POST", body: JSON.stringify({ files, force }) }),
  scmLog: (id: string, limit = 50) =>
    request<{ commits: import("./contracts").ScmLogEntry[] }>(`/api/sessions/${encodeURIComponent(id)}/git/log?limit=${limit}`),
  scmMergeWorktree: (id: string, name: string) =>
    request<import("./contracts").ScmWorktreeMergeResult>(`/api/sessions/${encodeURIComponent(id)}/git/worktrees/${encodeURIComponent(name)}/merge`, { method: "POST", body: JSON.stringify({}) }),
  importSession: async (jsonl: string): Promise<Session> => {
    const response = await fetch("/api/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: jsonl,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new ApiError(response.status, body.error ?? response.statusText);
    }
    return response.json() as Promise<Session>;
  },
  settings: () => request<SettingsView>("/api/settings"),
  skills: (id: string) => request<{ skills: SkillInfo[] }>(`/api/sessions/${id}/skills`),
  globalSkills: () => request<{ skills: SkillInfo[] }>("/api/skills"),
  costReport: (range: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    const query = params.toString();
    return request<CostReport>(`/api/reports/cost${query ? `?${query}` : ""}`);
  },
  saveSettings: (overrides: Record<string, SettingValue | null>) =>
    request<SettingsView>("/api/settings", { method: "PUT", body: JSON.stringify({ overrides }) }),
  tasks: (id: string) => request<BackgroundTaskInfo[]>(`/api/sessions/${id}/tasks`),
  task: (id: string, taskId: string) => request<BackgroundTaskInfo>(`/api/sessions/${id}/tasks/${taskId}`),
  subagentTranscript: (id: string, taskId: string) => request<SubagentTranscript>(`/api/sessions/${id}/subagents/${taskId}`),
  agents: () => request<AgentListResponse>("/api/agents"),
  // 手动启动子代理：202 返回 { taskId, toolCallId }；400=非法 prompt/agent，429=超出并发
  startSubagent: (id: string, body: { prompt: string; agent?: string }) =>
    request<StartSubagentResponse>(`/api/sessions/${id}/subagents`, { method: "POST", body: JSON.stringify(body) }),
  extensions: () => request<ExtensionInfo[]>("/api/extensions"),
  configureExtension: (id: string, body: { enabled?: boolean; config?: Record<string, unknown> }) =>
    request<ExtensionInfo>("/api/extensions", { method: "POST", body: JSON.stringify({ id, ...body }) }),
  installExtension: (path: string) => request<ExtensionInfo>("/api/extensions", { method: "POST", body: JSON.stringify({ action: "install", path }) }),
  envSimPersonas: () => request<{ personas: PersonaSummary[]; directory: string }>("/api/extensions/env-sim/personas"),
  envSimPersona: (id: string) => request<PersonaDetail>(`/api/extensions/env-sim/personas/${encodeURIComponent(id)}`),
  saveEnvSimPersona: (body: import("./contracts").PersonaPresetInput) =>
    request<PersonaDetail>("/api/extensions/env-sim/personas", { method: "POST", body: JSON.stringify(body) }),
  deleteEnvSimPersona: (id: string) =>
    request<{ ok: boolean }>(`/api/extensions/env-sim/personas/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uninstallExtension: (id: string) => request<void>(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // 会话格式升级（官方扩展 session-format-upgrade；未启用时 503）
  formatUpgrades: () => request<{ steps: Array<{ id: string; scope: string; description: string }> }>("/api/sessions/format-upgrades"),
  upgradeSessionFormat: (id: string, stepId?: string) =>
    request<{ steps: string[]; changed: number; backups: string[] }>(`/api/sessions/${encodeURIComponent(id)}/format-upgrade`, { method: "POST", body: JSON.stringify(stepId ? { stepId } : {}) }),
  upgradeAllSessionFormats: (stepId?: string) =>
    request<{ upgraded: number; total: number; skipped: string[]; failed: Array<{ id: string; error: string }>; backups: string[] }>("/api/sessions/format-upgrade-all", { method: "POST", body: JSON.stringify(stepId ? { stepId } : {}) }),
  translateMessage: (sessionId: string, messageId: string, targetLanguage: string, glossary?: Record<string, string>) =>
    request<{ text: string; cached: boolean }>(`/api/sessions/${sessionId}/content-lens/translate`, { method: "POST", body: JSON.stringify({ messageId, targetLanguage, ...(glossary ? { glossary } : {}) }) }),
  explainSelection: (sessionId: string, text: string, targetLanguage = "zh-CN") =>
    request<{ text: string }>(`/api/sessions/${sessionId}/content-lens/explain`, { method: "POST", body: JSON.stringify({ text, targetLanguage }) }),
  // 0.5.0 Phase 2d：性能采样（脱敏）
  sessionPerf: (id: string) => request<{ records: import("./contracts").RunPerfRecord[] }>(`/api/sessions/${encodeURIComponent(id)}/perf`),
  serverMetrics: () => request<{ events: { published: number; retained: number; retainedBytes: number; oversizedNotRetained: number }; websocket: { clients: number; slowClientDisconnects: number; failedClientSends: number } }>("/api/metrics"),
  // 0.5.0 Phase 3a：评测 harness
  evalTasks: () => request<{ tasks: import("./contracts").EvalTaskInfo[] }>("/api/eval/tasks"),
  evalRun: (taskIds?: string[]) =>
    request<import("./contracts").EvalRunReport>("/api/eval/run", { method: "POST", body: JSON.stringify({ ...(taskIds ? { taskIds } : {}) }) }),
  evalRunReport: (runId: string) => request<import("./contracts").EvalRunReport>(`/api/eval/runs/${encodeURIComponent(runId)}`),
  evalRuns: () => request<{ runs: import("./contracts").EvalRunSummary[] }>("/api/eval/runs"),
  evalCompare: (baselineRunId: string, candidateRunId: string) => request<import("./contracts").EvalRunComparison>("/api/eval/compare", { method: "POST", body: JSON.stringify({ baselineRunId, candidateRunId }) }),
  evalComparisons: () => request<{ comparisons: import("./contracts").EvalComparisonSummary[] }>("/api/eval/comparisons"),
  evalComparison: (comparisonId: string) => request<import("./contracts").EvalRunComparison>(`/api/eval/comparisons/${encodeURIComponent(comparisonId)}`),
  // chat 模式（ChatGPT 风格）：与主路径同一 request 封装（ApiError 归一化 + 401 广播）。
  // 响应体宽松类型（unknown/void）仅作状态判定，调用方按各自契约解析。
  chatSession: (id: string) => request<import("./contracts").ChatSessionDetail>(`/api/chat/sessions/${id}`),
  chatSessions: () => request<import("./contracts").ChatSessionMeta[]>("/api/chat/sessions"),
  chatCreateSession: (body: { provider: string; model: string }) =>
    request<import("./contracts").ChatSessionMeta>("/api/chat/sessions", { method: "POST", body: JSON.stringify(body) }),
  chatDelete: (id: string) => request<void>(`/api/chat/sessions/${id}`, { method: "DELETE" }),
  chatPatch: (id: string, body: Record<string, unknown>) =>
    request<import("./contracts").ChatSessionMeta>(`/api/chat/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  chatAssistants: () => request<import("./contracts").ChatAssistant[]>("/api/chat/assistants"),
  chatModels: () => request<import("./contracts").ChatModelEntry[]>("/api/chat/models"),
  chatConfig: () => request<import("./contracts").ChatConfig>("/api/chat/config"),
  chatSaveConfig: (config: Record<string, unknown>) =>
    request<import("./contracts").ChatConfig>("/api/chat/config", { method: "PUT", body: JSON.stringify(config) }),
  chatRetry: (id: string, messageId: string) =>
    request<{ accepted?: boolean }>(`/api/chat/sessions/${id}/messages/${messageId}/retry`, { method: "POST" }),
  chatEdit: (id: string, messageId: string, text: string) =>
    request<{ accepted?: boolean }>(`/api/chat/sessions/${id}/messages/${messageId}/edit`, { method: "POST", body: JSON.stringify({ text }) }),
  chatSend: (id: string, body: Record<string, unknown>) =>
    request<{ runId: string }>(`/api/chat/sessions/${id}/messages`, { method: "POST", body: JSON.stringify(body) }),
  chatStop: (id: string) => request<void>(`/api/chat/sessions/${id}/stop`, { method: "POST" }),
  chatUploadImage: (id: string, body: { data: string; mediaType: string; filename: string }) =>
    request<{ ref: string }>(`/api/chat/sessions/${id}/uploads`, { method: "POST", body: JSON.stringify(body) }),
  chatCreateShare: (id: string, password?: string) =>
    request<import("./contracts").ChatShare>(`/api/chat/sessions/${id}/share`, { method: "POST", body: JSON.stringify(password ? { password } : {}) }),
  chatRevokeShare: (id: string) => request<void>(`/api/chat/sessions/${id}/share`, { method: "DELETE" }),
  chatBranches: (id: string) =>
    request<{ sessionId: string }>(`/api/chat/sessions/${id}/branches`, { method: "POST" }),
  // 公开只读分享页：401 是「需要口令/口令错误」业务流，不触发登录页兜底广播
  shareMessages: (shareId: string, token?: string) =>
    request<{ title: string; slug: string; messages: import("./contracts").ChatMessage[] }>(`/api/share/${shareId}/messages${token ? `?token=${encodeURIComponent(token)}` : ""}`, undefined, { broadcastUnauthorized: false }),
  shareVerify: (shareId: string, password?: string) =>
    request<{ verified: boolean; shareId: string; slug: string; token?: string }>(`/api/share/${shareId}/verify`, { method: "POST", body: JSON.stringify(password ? { password } : {}) }, { broadcastUnauthorized: false }),
};
