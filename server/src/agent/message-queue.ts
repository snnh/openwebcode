import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeUtf8Atomically } from "../atomic-file.js";
import { isMissing } from "../fs-utils.js";

export type QueueKind = "steer" | "follow_up";
export type QueueStatus = "queued" | "consuming" | "applied" | "cancelled";

export interface QueueItem {
  id: string;
  sessionId: string;
  kind: QueueKind;
  content: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  appliedMessageId?: string;
  /** 注入来源标记（提交⑫ cron 定时任务）；旧 queue.json 无此字段，读取容忍 undefined。 */
  source?: "cron";
}

interface QueueDocument {
  version: 1;
  items: QueueItem[];
}

/** Small mutable queue state. All mutations are serialized per session and
 * atomically replace queue.json, while chat history remains append-only. */
export class MessageQueue {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly contextRoot: (sessionId: string) => string) {}

  async enqueue(sessionId: string, kind: QueueKind, content: string, requestId?: string, source?: "cron"): Promise<{ item: QueueItem; position: number; reused: boolean }> {
    return this.mutate(sessionId, (items) => {
      const existing = requestId ? items.find((item) => item.kind === kind && item.requestId === requestId) : undefined;
      if (existing) {
        return { item: clone(existing), position: items.filter((entry) => entry.kind === kind && entry.status === "queued").findIndex((entry) => entry.id === existing.id) + 1, reused: true };
      }
      const now = new Date().toISOString();
      const item: QueueItem = { id: randomUUID(), sessionId, kind, content, status: "queued", createdAt: now, updatedAt: now, ...(requestId ? { requestId } : {}), ...(source ? { source } : {}) };
      items.push(item);
      return { item: clone(item), position: items.filter((entry) => entry.kind === kind && entry.status === "queued").length, reused: false };
    });
  }

  async list(sessionId: string, kind?: QueueKind): Promise<QueueItem[]> {
    await this.writes.get(sessionId)?.catch(() => undefined);
    const items = await this.read(sessionId);
    return items.filter((item) => !kind || item.kind === kind).map(clone);
  }

  async cancel(sessionId: string, id: string): Promise<QueueItem | undefined> {
    return this.mutate(sessionId, (items) => {
      const item = items.find((entry) => entry.id === id && entry.status === "queued");
      if (!item) return undefined;
      item.status = "cancelled";
      item.updatedAt = new Date().toISOString();
      return clone(item);
    });
  }

  async update(sessionId: string, id: string, change: { content?: string; kind?: QueueKind }): Promise<QueueItem | undefined> {
    return this.mutate(sessionId, (items) => {
      const item = items.find((entry) => entry.id === id && entry.status === "queued");
      if (!item) return undefined;
      if (change.content !== undefined) item.content = change.content;
      if (change.kind !== undefined) item.kind = change.kind;
      item.updatedAt = new Date().toISOString();
      return clone(item);
    });
  }

  async take(sessionId: string, kind: QueueKind): Promise<QueueItem | undefined> {
    return this.mutate(sessionId, (items) => {
      const item = items.find((entry) => entry.kind === kind && entry.status === "queued");
      if (!item) return undefined;
      item.status = "consuming";
      item.updatedAt = new Date().toISOString();
      return clone(item);
    });
  }

  async apply(sessionId: string, id: string, appliedMessageId: string): Promise<QueueItem | undefined> {
    return this.mutate(sessionId, (items) => {
      const item = items.find((entry) => entry.id === id && entry.status === "consuming");
      if (!item) return undefined;
      item.status = "applied";
      item.appliedMessageId = appliedMessageId;
      item.updatedAt = new Date().toISOString();
      return clone(item);
    });
  }

  /** Return a claimed item to the queue when appending it to history fails. */
  async requeue(sessionId: string, id: string): Promise<QueueItem | undefined> {
    return this.mutate(sessionId, (items) => {
      const item = items.find((entry) => entry.id === id && entry.status === "consuming");
      if (!item) return undefined;
      item.status = "queued";
      item.updatedAt = new Date().toISOString();
      return clone(item);
    });
  }

  private async mutate<T>(sessionId: string, change: (items: QueueItem[]) => T): Promise<T> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const items = await this.read(sessionId);
      const result = change(items);
      await writeUtf8Atomically(this.pathFor(sessionId), `${JSON.stringify({ version: 1, items } satisfies QueueDocument, null, 2)}\n`);
      return result;
    });
    this.writes.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(sessionId) === operation) this.writes.delete(sessionId);
    }
  }

  private async read(sessionId: string): Promise<QueueItem[]> {
    try {
      const document = JSON.parse(await readFile(this.pathFor(sessionId), "utf8")) as QueueDocument;
      if (document.version !== 1 || !Array.isArray(document.items)) throw new Error("Invalid queue.json");
      return document.items.map(clone);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private pathFor(sessionId: string): string {
    return path.join(this.contextRoot(sessionId), "queue.json");
  }
}

function clone(item: QueueItem): QueueItem {
  return { ...item };
}
