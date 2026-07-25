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

/**
 * 可追加型 delta 事件的合批窗口（毫秒），与客户端按帧渲染节奏对齐。
 * 只作用于 payload 形如 `{ text: string }` 的纯追加 delta；
 * 状态迁移、权限、交互等非 delta 事件永不进入合批，即时发布。
 */
export const DELTA_BATCH_WINDOW_MS = 16;

/** 允许合批的事件类型：同一 (sessionId, type) 键下的 text 可直接拼接。 */
const BATCHABLE_DELTA_TYPES = new Set(["message.delta", "message.thinking_delta"]);

interface PendingDelta {
  input: AppEventInput;
  text: string;
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
  /** 合批缓冲区：键为 `${sessionId ?? ""}${type}`，值为待合并的 delta。 */
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  private deltaFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly historyLimit = 1_000,
    private readonly historyByteLimit = 4 * 1024 * 1024,
    private readonly deltaBatchWindowMs: number = DELTA_BATCH_WINDOW_MS,
  ) {
    super();
  }

  publish(input: AppEventInput): AppEvent {
    if (this.isBatchableDelta(input)) return this.bufferDelta(input);
    // 非 delta 事件不得被合批延迟；先把挂起的 delta 冲刷出去，保住全局发布顺序。
    this.flushDeltas();
    return this.publishNow(input);
  }

  /**
   * 判定是否为可合批的纯追加 delta：类型在白名单内且 payload 仅为 `{ text }` 追加。
   */
  private isBatchableDelta(input: AppEventInput): boolean {
    if (this.deltaBatchWindowMs <= 0 || !BATCHABLE_DELTA_TYPES.has(input.type)) return false;
    const payload = input.payload;
    return typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string";
  }

  /**
   * 把 delta 并入 (sessionId, type) 键对应的缓冲，并在窗口到期时合并发布。
   * 返回值为占位事件（seq 指向最后一条已定序事件），实际事件在 flush 时才定序；
   * 当前没有调用方消费 delta 发布的返回值。
   */
  private bufferDelta(input: AppEventInput): AppEvent {
    const key = `${input.sessionId ?? ""}${input.type}`;
    const text = (input.payload as { text: string }).text;
    const pending = this.pendingDeltas.get(key);
    if (pending) pending.text += text;
    else this.pendingDeltas.set(key, { input, text });
    if (!this.deltaFlushTimer) {
      this.deltaFlushTimer = setTimeout(() => this.flushDeltas(), this.deltaBatchWindowMs);
      // 不让合批定时器阻止进程退出（测试与 CLI 短生命周期场景）。
      this.deltaFlushTimer.unref?.();
    }
    return {
      ...input,
      payload: { ...(input.payload as Record<string, unknown>), text: this.pendingDeltas.get(key)!.text },
      eventId: "pending",
      seq: this.sequence,
      createdAt: new Date().toISOString(),
    };
  }

  /** 立即合并发布所有挂起的 delta（每个 (sessionId, type) 键一条事件）。 */
  flushDeltas(): void {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = undefined;
    }
    if (this.pendingDeltas.size === 0) return;
    const pending = [...this.pendingDeltas.values()];
    this.pendingDeltas.clear();
    for (const delta of pending) {
      this.publishNow({ ...delta.input, payload: { ...(delta.input.payload as Record<string, unknown>), text: delta.text } });
    }
  }

  private publishNow(input: AppEventInput): AppEvent {
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
    // 先冲刷挂起的合批 delta，保证 replay 看到完整的已定序历史。
    this.flushDeltas();
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
