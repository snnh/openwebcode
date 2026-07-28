import type { AgentListResponse, AgentRun, BackgroundTaskInfo, CatalogSyncStatus, Checkpoint, CompletePathResponse, ContextView, CostReport, ExtensionInfo, FileEntry, ManagedWorkspaceCapability, ManagedWorkspaceSyncPreview, ManagedWorkspaceSyncResult, MessageAttachment, MessagesPage, ModelProfile, PendingPermission, PricingDocument, ProviderConcurrencyStats, ProviderConnectionTestResult, ProviderProfilesView, SandboxCapabilities, SandboxMode, Session, SessionDetail, SettingsView, SettingValue, SkillInfo, SnapshotCapabilityInfo, StartSubagentResponse, SubagentTranscript, SyncResult, TodoItem, WebCapability } from "./contracts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  // 仅有 body 时声明 content-type，避免 Fastify 对空 body 的 POST 报校验错误
  if (init?.body && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new ApiError(response.status, body.error ?? response.statusText);
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
  version: () => request<import("./contracts").VersionInfo>("/api/version"),
  updateCheck: () => request<import("./contracts").UpdateCheckResponse>("/api/update-check"),
  refreshUpdateCheck: () => request<import("./contracts").UpdateCheckResponse>("/api/update-check/refresh", { method: "POST" }),
  // 在线更新（应用内升级）：POST 202 返回初始状态；400=已是最新/平台不支持，409=已有更新进行中，501=未配置
  updateApplyStatus: () => request<{ state: import("./contracts").UpdateApplyState | null }>("/api/update/apply"),
  updateApplyStart: () => request<{ state: import("./contracts").UpdateApplyState }>("/api/update/apply", { method: "POST" }),
  promptOverride: (cwd?: string) => request<import("./contracts").PromptOverrideView>(`/api/prompt${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  savePromptOverride: (body: { baseOverride?: string | null; customAppend?: string | null }) =>
    request<{ ok: boolean }>("/api/prompt", { method: "PUT", body: JSON.stringify(body) }),
  providerStats: () => request<Record<string, ProviderConcurrencyStats>>("/api/providers/stats"),
  indexStatus: (sessionId: string) => request<import("./contracts").WorkspaceIndexStatus>(`/api/workspaces/index/status?sessionId=${encodeURIComponent(sessionId)}`),
  rebuildIndex: (sessionId: string) => request<{ accepted: boolean; jobId: string }>("/api/workspaces/index/rebuild", { method: "POST", body: JSON.stringify({ sessionId }) }),
  session: (id: string, limit?: number) => request<SessionDetail>(`/api/sessions/${id}${limit ? `?limit=${limit}` : ""}`),
  messagesPage: (id: string, before: string, limit?: number) => request<MessagesPage>(`/api/sessions/${id}/messages?before=${encodeURIComponent(before)}${limit ? `&limit=${limit}` : ""}`),
  run: (id: string) => request<AgentRun>(`/api/sessions/${id}/run`),
  createSession: (body: { cwd: string; provider: string; model: string; title?: string; agentMode?: "plan" | "build"; sandboxMode?: SandboxMode; setupScript?: string; workspaceMode?: "managed" }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  sandboxCapabilities: () => request<SandboxCapabilities>("/api/sandbox/capabilities"),
  managedWorkspaceCapability: () => request<ManagedWorkspaceCapability>("/api/managed-workspace/capability"),
  workspaceSyncPreview: (id: string) => request<ManagedWorkspaceSyncPreview>(`/api/sessions/${encodeURIComponent(id)}/workspace/sync-preview`),
  syncWorkspace: (id: string, body: { confirm: true; previewFingerprint: string; overwriteConflicts?: boolean }) =>
    request<ManagedWorkspaceSyncResult>(`/api/sessions/${encodeURIComponent(id)}/workspace/sync`, { method: "POST", body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  // 会话显示属性：title ≤120 字符（空串清除覆盖回落派生标题），pinned 控制列表置顶
  patchSession: (id: string, body: { title?: string; pinned?: boolean }) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  sendMessage: (id: string, content: string, images?: Array<{ mediaType: string; data: string }>, attachments?: MessageAttachment[], behavior: "start" | "steer" | "follow_up" = "start") =>
    request<{ accepted: boolean; queued?: boolean; position?: number; compacted?: boolean; behavior?: string; reused?: boolean }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content, behavior, ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) }) }),
  interactions: (id: string) => request<import("./contracts").InteractionRequest[]>(`/api/sessions/${id}/interactions`),
  timeline: (id: string) => request<import("./contracts").SessionTimeline>(`/api/sessions/${id}/timeline`),
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
  saveModel: (id: string, body: { provider?: string; originalProvider?: string; displayName?: string; contextWindow?: number; maxOutput?: number; capabilities?: ModelProfile["capabilities"] }) =>
    request<ModelProfile>(`/api/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteModel: (id: string, provider?: string) => request<void>(`/api/models/${encodeURIComponent(id)}${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { method: "DELETE" }),
  modelPricing: () => request<PricingDocument>("/api/model-pricing"),
  syncModelPricing: () => request<SyncResult>("/api/model-pricing/sync", { method: "POST" }),
  saveModelPricing: (document: PricingDocument) =>
    request<PricingDocument>("/api/model-pricing", { method: "PUT", body: JSON.stringify(document) }),
  listFiles: (id: string, path = ".") => request<{ entries: FileEntry[]; truncated: boolean }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
  readFile: (id: string, path: string) => request<{ content: string; encoding: string; truncated: boolean; revision: string }>(`/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`),
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
  steering: (id: string) => request<Array<{ id: string; content: string; createdAt: string }>>(`/api/sessions/${id}/steering`),
  removeSteering: (id: string, itemId: string) => request<void>(`/api/sessions/${id}/steering/${itemId}`, { method: "DELETE" }),
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
  envSimPersonas: () => request<{ personas: Array<{ id: string; name: string; builtin: boolean }>; directory: string }>("/api/extensions/env-sim/personas"),
  uninstallExtension: (id: string) => request<void>(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
};
