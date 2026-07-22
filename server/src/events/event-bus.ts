import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface AppEventInput {
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  /** Present for lifecycle events belonging to a persisted agent run. */
  runId?: string;
  payload: unknown;
}

export interface AppEvent extends AppEventInput {
  eventId: string;
  seq: number;
  /** Monotonic only within a session; used for session-filtered replay. */
  sessionSeq?: number;
  createdAt: string;
}

export interface ReplayResult {
  events: AppEvent[];
  requiresResync: boolean;
  latestSeq: number;
}

export interface EventBusStats {
  published: number;
  retained: number;
  retainedBytes: number;
  oversizedNotRetained: number;
}

export class EventBus extends EventEmitter {
  private sequence = 0;
  private readonly sessionSequences = new Map<string, number>();
  private readonly history: AppEvent[] = [];
  private historyBytes = 0;
  private oversizedNotRetained = 0;

  constructor(private readonly historyLimit = 1_000, private readonly historyByteLimit = 4 * 1024 * 1024) {
    super();
  }

  publish(input: AppEventInput): AppEvent {
    const sessionSeq = input.sessionId
      ? (this.sessionSequences.get(input.sessionId) ?? 0) + 1
      : undefined;
    if (input.sessionId) this.sessionSequences.set(input.sessionId, sessionSeq!);
    const event: AppEvent = {
      ...input,
      eventId: randomUUID(),
      seq: ++this.sequence,
      ...(sessionSeq === undefined ? {} : { sessionSeq }),
      createdAt: new Date().toISOString(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    // A single oversize event is still delivered live, but never retained for
    // replay: retaining it would defeat the history memory budget.
    if (bytes <= this.historyByteLimit) {
      this.history.push(event);
      this.historyBytes += bytes;
      while (this.history.length > this.historyLimit || this.historyBytes > this.historyByteLimit) {
        const removed = this.history.shift();
        if (removed) this.historyBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      }
    } else this.oversizedNotRetained++;
    this.emit("event", event);
    return event;
  }

  replay(after: number, sessionId?: string): ReplayResult {
    if (sessionId) {
      const history = this.history.filter((event) => event.sessionId === sessionId);
      const oldest = history[0]?.sessionSeq ?? (this.sessionSequences.get(sessionId) ?? 0) + 1;
      const latestSeq = this.sessionSequences.get(sessionId) ?? 0;
      const requiresResync = after > 0 && after < oldest - 1;
      return {
        events: requiresResync ? [] : history.filter((event) => (event.sessionSeq ?? 0) > after),
        requiresResync,
        latestSeq,
      };
    }
    // oldest 是当前缓冲区里最旧事件的 seq；历史为空时取 sequence+1（一个不存在的 seq），
    // 使 after>=1 的请求都判定为需要 resync。`after < oldest - 1` 表示客户端想从
    // after+1 开始补拉，但 after+1 已早于现存最旧事件 oldest，无法连续补齐 → 要求 REST resync。
    const oldest = this.history[0]?.seq ?? this.sequence + 1;
    const latestRetained = this.history.at(-1)?.seq ?? 0;
    const requiresResync = (after > 0 && after < oldest - 1) || (after < this.sequence && latestRetained !== this.sequence);
    const events = requiresResync
      ? []
      : this.history.filter((event) =>
          event.seq > after && (!sessionId || !event.sessionId || event.sessionId === sessionId));
    return { events, requiresResync, latestSeq: this.sequence };
  }

  latestSeq(): number {
    return this.sequence;
  }

  stats(): EventBusStats {
    return {
      published: this.sequence,
      retained: this.history.length,
      retainedBytes: this.historyBytes,
      oversizedNotRetained: this.oversizedNotRetained,
    };
  }
}
