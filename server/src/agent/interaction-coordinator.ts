import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";

export type InteractionKind = "confirm" | "single_select" | "multi_select" | "text" | "plan_approval";
export type InteractionStatus = "pending" | "answered" | "cancelled";
export interface InteractionRequest {
  id: string; sessionId: string; runId: string; toolCallId?: string; kind: InteractionKind;
  title: string; prompt: string; options?: Array<{ id: string; label: string; description?: string }>;
  status: InteractionStatus; createdAt: string; answer?: unknown; answeredAt?: string;
}
interface Document { version: 1; items: InteractionRequest[]; }
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** 已完结（answered/cancelled）交互的保留上限：超出时裁剪最旧的完结项，pending 永不裁剪。
 *  interactions.json 只追加不清扫会在长期会话里持续增长，此处与项目其他有界日志同一纪律。 */
const MAX_RESOLVED_INTERACTIONS = 500;

function pruneResolved(items: InteractionRequest[]): void {
  let excess = items.filter((item) => item.status !== "pending").length - MAX_RESOLVED_INTERACTIONS;
  for (let index = 0; index < items.length && excess > 0;) {
    if (items[index]!.status === "pending") { index += 1; continue; }
    items.splice(index, 1);
    excess -= 1;
  }
}

/** Durable, small interaction state. It is deliberately separate from chat history. */
export class InteractionCoordinator {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly contextRoot: (sessionId: string) => string) {}
  async list(sessionId: string): Promise<InteractionRequest[]> { await this.writes.get(sessionId)?.catch(() => undefined); return (await this.read(sessionId)).map((item) => ({ ...item })); }
  async create(sessionId: string, input: Omit<InteractionRequest, "id" | "sessionId" | "status" | "createdAt">): Promise<InteractionRequest> {
    return this.mutate(sessionId, (items) => { const item: InteractionRequest = { ...input, id: randomUUID(), sessionId, status: "pending", createdAt: new Date().toISOString() }; items.push(item); return { ...item }; });
  }
  async answer(sessionId: string, id: string, answer: unknown): Promise<InteractionRequest | undefined> {
    return this.mutate(sessionId, (items) => { const item = items.find((entry) => entry.id === id && entry.status === "pending"); if (!item) return undefined; item.status = "answered"; item.answer = answer; item.answeredAt = new Date().toISOString(); return { ...item }; });
  }
  private async mutate<T>(sessionId: string, change: (items: InteractionRequest[]) => T): Promise<T> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve(); const operation = previous.catch(() => undefined).then(async () => { const items = await this.read(sessionId); const result = change(items); pruneResolved(items); await writeUtf8Atomically(this.file(sessionId), `${JSON.stringify({ version: 1, items } satisfies Document, null, 2)}\n`); return result; }); this.writes.set(sessionId, operation); try { return await operation; } finally { if (this.writes.get(sessionId) === operation) this.writes.delete(sessionId); }
  }
  private async read(sessionId: string): Promise<InteractionRequest[]> { try { const doc = JSON.parse(await readFile(this.file(sessionId), "utf8")) as Document; if (doc.version !== 1 || !Array.isArray(doc.items)) throw new Error("Invalid interactions.json"); return doc.items; } catch (error) { if (missing(error)) return []; throw error; } }
  private file(sessionId: string): string { return path.join(this.contextRoot(sessionId), "interactions.json"); }
}
