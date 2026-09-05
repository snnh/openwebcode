import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

interface AppEventInput {
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

interface ReplayResult {
  events: AppEvent[];
  requiresResync: boolean;
  latestSeq: number;
}

/**
 * 可追加型 delta 事件的合批窗口（毫秒），与客户端按帧渲染节奏对齐。
 * 只作用于 payload 形如 `{ text: string }` 的纯追加 delta；
 * 状态迁移、权限、交互等非 delta 事件永不进入合批，即时发布。
 */
const DELTA_BATCH_WINDOW_MS = 16;

/** 允许合批的事件类型：同一 (sessionId, type, id) 键下的 text 可直接拼接。
 * message.tool_call_delta 的 payload.id 区分并行工具调用，合批键必须带 id 防串线。 */
const BATCHABLE_DELTA_TYPES = new Set(["message.delta", "message.thinking_delta", "message.tool_call_delta"]);

interface PendingDelta {
  input: AppEventInput;
  text: string;
}

/**
 * delta 合批占位的共享 sentinel：被合批的 delta 在 flush 时才定序，
 * 全仓没有调用方消费 delta 发布的返回值，因此返回模块级冻结对象，
 * 避免长流下每个 token delta 都构造一次新对象（字段为固定占位值）。
 */
const PENDING_DELTA_EVENT: AppEvent = Object.freeze({
  source: "agent",
  type: "message.delta",
  payload: null,
  eventId: "pending",
  seq: 0,
  createdAt: "",
});

interface EventBusStats {
  published: number;
  retained: number;
  retainedBytes: number;
  oversizedNotRetained: number;
}

/** 历史条目：事件本体 + 发布时一次性算出的字节数与序列化串（回放重传与 fan-out 复用，避免重复 stringify）。 */
interface HistoryEntry {
  event: AppEvent;
  bytes: number;
  serialized: string;
}

export class EventBus extends EventEmitter {
  private sequence = 0;
  private readonly sessionSequences = new Map<string, number>();
  private readonly history: HistoryEntry[] = [];
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
   * 实际事件在 flush 时才定序；当前没有调用方消费 delta 发布的返回值，
   * 因此返回共享的冻结 sentinel，不再逐条构造占位对象。
   */
  private bufferDelta(input: AppEventInput): AppEvent {
    const key = `${input.sessionId ?? ""}${input.type} ${(input.payload as { id?: string }).id ?? ""}`;
    const text = (input.payload as { text: string }).text;
    const pending = this.pendingDeltas.get(key);
    if (pending) pending.text += text;
    else this.pendingDeltas.set(key, { input, text });
    if (!this.deltaFlushTimer) {
      this.deltaFlushTimer = setTimeout(() => this.flushDeltas(), this.deltaBatchWindowMs);
      // 不让合批定时器阻止进程退出（测试与 CLI 短生命周期场景）。
      this.deltaFlushTimer.unref?.();
    }
    return PENDING_DELTA_EVENT;
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
    const serialized = JSON.stringify(event);
    const bytes = Buffer.byteLength(serialized, "utf8");
    // A single oversize event is still delivered live, but never retained for
    // replay: retaining it would defeat the history memory budget.
    if (bytes <= this.historyByteLimit) {
      this.history.push({ event, bytes, serialized });
      this.historyBytes += bytes;
      if (this.history.length > this.historyLimit || this.historyBytes > this.historyByteLimit) {
        // 批量逐出（迟滞）：超限后一次 splice 回到超限上限的 90%，
        // 摊销稳态下每条事件一次 O(n) shift 的整体搬移；FIFO 顺序与字节记账不变。
        const targetLength = this.history.length > this.historyLimit ? Math.floor(this.historyLimit * 0.9) : this.history.length;
        const targetBytes = this.historyBytes > this.historyByteLimit ? Math.floor(this.historyByteLimit * 0.9) : this.historyBytes;
        let remove = 0;
        let freed = 0;
        while (remove < this.history.length && (this.history.length - remove > targetLength || this.historyBytes - freed > targetBytes)) {
          freed += this.history[remove]!.bytes;
          remove++;
        }
        this.history.splice(0, remove);
        this.historyBytes -= freed;
      }
    } else this.oversizedNotRetained++;
    this.emit("event", event, serialized);
    return event;
  }

  /** replay 与 replaySerialized 共用的历史筛选：返回匹配的历史条目（含预序列化串）。 */
  private replayEntries(after: number, sessionId?: string): { entries: HistoryEntry[]; requiresResync: boolean; latestSeq: number } {
    // 先冲刷挂起的合批 delta，保证 replay 看到完整的已定序历史。
    this.flushDeltas();
    if (sessionId) {
      const history = this.history.filter((entry) => entry.event.sessionId === sessionId);
      const oldest = history[0]?.event.sessionSeq ?? (this.sessionSequences.get(sessionId) ?? 0) + 1;
      const latestSeq = this.sessionSequences.get(sessionId) ?? 0;
      const requiresResync = after > 0 && after < oldest - 1;
      return {
        entries: requiresResync ? [] : history.filter((entry) => (entry.event.sessionSeq ?? 0) > after),
        requiresResync,
        latestSeq,
      };
    }
    // oldest 是当前缓冲区里最旧事件的 seq；历史为空时取 sequence+1（一个不存在的 seq），
    // 使 after>=1 的请求都判定为需要 resync。`after < oldest - 1` 表示客户端想从
    // after+1 开始补拉，但 after+1 已早于现存最旧事件 oldest，无法连续补齐 → 要求 REST resync。
    const oldest = this.history[0]?.event.seq ?? this.sequence + 1;
    const latestRetained = this.history.at(-1)?.event.seq ?? 0;
    const requiresResync = (after > 0 && after < oldest - 1) || (after < this.sequence && latestRetained !== this.sequence);
    const entries = requiresResync ? [] : this.history.filter((entry) => entry.event.seq > after);
    return { entries, requiresResync, latestSeq: this.sequence };
  }

  replay(after: number, sessionId?: string): ReplayResult {
    const { entries, requiresResync, latestSeq } = this.replayEntries(after, sessionId);
    return { events: entries.map((entry) => entry.event), requiresResync, latestSeq };
  }

  /**
   * 与 replay 相同的筛选与 resync 判定，但直接透出发布时算好的预序列化串：
   * WS 回放路径逐条 send 时免去重复 JSON.stringify。返回形状与 replay 一一对应。
   */
  replaySerialized(after: number, sessionId?: string): { serialized: string[]; requiresResync: boolean; latestSeq: number } {
    const { entries, requiresResync, latestSeq } = this.replayEntries(after, sessionId);
    return { serialized: entries.map((entry) => entry.serialized), requiresResync, latestSeq };
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

  /** 释放定时器与缓存，供服务关闭/测试 teardown 使用，避免长生命周期实例残留。 */
  dispose(): void {
    this.flushDeltas();
    this.pendingDeltas.clear();
    this.sessionSequences.clear();
    this.history.length = 0;
    this.historyBytes = 0;
    this.removeAllListeners();
  }
}
