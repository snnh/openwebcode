import type { Checkpoint, ContextView, FileEntry, ModelProfile, Session, SessionDetail } from "./contracts";

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
  session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (body: { cwd: string; provider: string; model: string; title?: string }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  sendMessage: (id: string, content: string) =>
    request<{ accepted: boolean; queued?: boolean; position?: number }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  abort: (id: string) => request<{ accepted: boolean }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  respondPermission: (id: string, body: { requestId: string; decision: "allow" | "allow_always" | "deny"; reason?: string }) =>
    request<{ accepted: boolean }>(`/api/sessions/${id}/permissions/respond`, { method: "POST", body: JSON.stringify(body) }),
  updateSession: (id: string, body: Record<string, unknown>) =>
    request<Session>(`/api/sessions/${id}/config`, { method: "PUT", body: JSON.stringify(body) }),
  context: (id: string) => request<ContextView>(`/api/sessions/${id}/context`),
  checkpoints: (id: string) => request<Checkpoint[]>(`/api/sessions/${id}/checkpoints`),
  createCheckpoint: (id: string, label?: string) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints`, { method: "POST", body: JSON.stringify({ label }) }),
  restoreCheckpoint: (id: string, checkpointId: string, filesOnly = false) =>
    request<Checkpoint>(`/api/sessions/${id}/checkpoints/${checkpointId}/restore`, { method: "POST", body: JSON.stringify({ confirm: true, filesOnly }) }),
  checkpointDiff: (id: string, checkpointId: string) =>
    request<{ diff: string }>(`/api/sessions/${id}/checkpoints/${checkpointId}/diff`),
  providers: () => request<Array<{ name: string }>>("/api/providers"),
  models: () => request<ModelProfile[]>("/api/models"),
  listFiles: (id: string, path = ".") => request<{ entries: FileEntry[]; truncated: boolean }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
  readFile: (id: string, path: string) => request<{ content: string; encoding: string; truncated: boolean }>(`/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`),
  steering: (id: string) => request<Array<{ id: string; content: string; createdAt: string }>>(`/api/sessions/${id}/steering`),
  removeSteering: (id: string, itemId: string) => request<void>(`/api/sessions/${id}/steering/${itemId}`, { method: "DELETE" }),
};
