import type { Checkpoint, ContextView, CostReport, FileEntry, ModelProfile, PendingPermission, PricingDocument, Session, SessionDetail, SettingsView, SettingValue, SkillInfo } from "./contracts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new ApiError(response.status, body.error ?? response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  sessions: () => request<Session[]>("/api/sessions"),
  health: () => request<{ status: string }>("/api/health"),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (body: { cwd: string; provider: string; model: string; title?: string }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  sendMessage: (id: string, content: string) =>
    request<{ accepted: boolean; queued?: boolean; position?: number }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  abort: (id: string) => request<{ accepted: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  respondPermission: (id: string, body: { requestId: string; decision: "allow" | "allow_always" | "deny"; reason?: string }) =>
    request<{ accepted: boolean }>(`/api/sessions/${id}/permissions/respond`, { method: "POST", body: JSON.stringify(body) }),
  pendingPermissions: (id: string) => request<PendingPermission[]>(`/api/sessions/${id}/permissions`),
  updateSession: (id: string, body: Record<string, unknown>) =>
    request<Session>(`/api/sessions/${id}/config`, { method: "PUT", body: JSON.stringify(body) }),
  context: (id: string) => request<ContextView>(`/api/sessions/${id}/context`),
  updateBudget: (id: string, body: { maxSessionTokens?: number | null; maxSessionCost?: { amount: string; currency?: string } | null }) =>
    request<void>(`/api/sessions/${id}/context/budget`, { method: "PUT", body: JSON.stringify(body) }),
  restoreContext: (id: string, messageId: string) =>
    request<void>(`/api/sessions/${id}/context/restore`, { method: "POST", body: JSON.stringify({ messageId }) }),
  checkpoints: (id: string) => request<Checkpoint[]>(`/api/sessions/${id}/checkpoints`),
  createCheckpoint: (id: string, label?: string) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ label }) }),
  restoreCheckpoint: (id: string, checkpointId: string, filesOnly = false) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints/${checkpointId}/restore`, { method: "POST", body: JSON.stringify({ confirm: true, filesOnly }) }),
  checkpointDiff: (id: string, checkpointId: string) =>
    request<{ diff: string }>(`/api/sessions/${id}/checkpoints/${checkpointId}/diff`),
  providers: () => request<string[]>("/api/providers"),
  models: () => request<ModelProfile[]>("/api/models"),
  refreshModels: () => request<{ added: number; total: number; errors: string[] }>("/api/models/refresh", { method: "POST" }),
  saveModel: (id: string, body: { provider?: string; displayName?: string; contextWindow?: number; maxOutput?: number }) =>
    request<ModelProfile>(`/api/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteModel: (id: string) => request<void>(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  modelPricing: () => request<PricingDocument>("/api/model-pricing"),
  saveModelPricing: (document: PricingDocument) =>
    request<PricingDocument>("/api/model-pricing", { method: "PUT", body: JSON.stringify(document) }),
  listFiles: (id: string, path = ".") => request<{ entries: FileEntry[]; truncated: boolean }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
  readFile: (id: string, path: string) => request<{ content: string; encoding: string; truncated: boolean }>(`/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`),
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
};
