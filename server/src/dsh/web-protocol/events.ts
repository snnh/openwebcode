/**
 * dsh `$events` 连接代事件流（M4 翻译层骨架）。
 *
 * 契约（`packages/api/gateway/src/stream-protocol.ts`）：
 *   Host → 客户端（逻辑流 item 帧的 value，判别式 `type`）：
 *     ready      { clientId, host: { home } }                   连接代可用信号（客户端据此做 baseline）
 *     emit       { event, args: [...] }                         广播事件
 *     waterfall  { event, eventId, agentId, request }           需客户端决定的请求（审批/提问）
 *     cancel     { eventId }                                    请求作废
 *   客户端 → Host（unary `POST /api/$events/result`，args 必须恰好三个键）：
 *     { clientId, eventId, outcome: { kind:'next' } | { kind:'result', value? } | { kind:'rejected', error } }
 *
 * 本模块只管连接代状态与帧；owc 事件 → dsh 事件的**映射**由调用方注入（hook 事件、审批、提问）。
 */
import { randomUUID } from "node:crypto";

/** 连接代下行帧。 */
export type DshEventDownlinkFrame =
  | { type: "ready"; clientId: string; host: { home: string } }
  | { type: "emit"; event: string; args: readonly unknown[] }
  | { type: "waterfall"; event: string; eventId: string; agentId: string; request: Record<string, unknown> }
  | { type: "cancel"; eventId: string };

/** 客户端对 waterfall 的应答（三种 outcome）。 */
export type DshWaterfallOutcome =
  | { kind: "next" }
  | { kind: "result"; value?: unknown }
  | { kind: "rejected"; error: { name: string; message: string; code?: string; details?: unknown } };

/** `$events/result` 解析结果。 */
export interface DshEventResult {
  clientId: string;
  eventId: string;
  outcome: DshWaterfallOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 键集合精确匹配（上游用 exactKeys 拒绝多余字段）。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * 解析 `$events/result` 的 args（形状非法返回错误文案，调用方回 `gateway/bad-request`）。
 */
export function parseEventResult(args: Record<string, unknown>): { result: DshEventResult } | { error: string } {
  if (!hasExactKeys(args, ["clientId", "eventId", "outcome"])) return { error: "args 必须恰好含 clientId/eventId/outcome" };
  const { clientId, eventId, outcome } = args;
  if (typeof clientId !== "string" || clientId === "") return { error: "clientId 必须是非空字符串" };
  if (typeof eventId !== "string" || eventId === "") return { error: "eventId 必须是非空字符串" };
  if (!isRecord(outcome)) return { error: "outcome 必须是对象" };
  if (outcome.kind === "next") {
    if (!hasExactKeys(outcome, ["kind"])) return { error: "outcome=next 不接受额外字段" };
    return { result: { clientId, eventId, outcome: { kind: "next" } } };
  }
  if (outcome.kind === "result") {
    // 上游允许 `{kind:'result'}`（无 value 键）与 `{kind:'result', value}` 两形态
    const keys = Object.keys(outcome);
    if (keys.length !== 1 && !(keys.length === 2 && Object.prototype.hasOwnProperty.call(outcome, "value"))) {
      return { error: "outcome=result 只接受 value" };
    }
    return {
      result: {
        clientId,
        eventId,
        outcome: Object.prototype.hasOwnProperty.call(outcome, "value") ? { kind: "result", value: outcome.value } : { kind: "result" },
      },
    };
  }
  if (outcome.kind === "rejected") {
    if (!hasExactKeys(outcome, ["kind", "error"]) || !isRecord(outcome.error)) return { error: "outcome=rejected 需要 error 对象" };
    const raw = outcome.error;
    if (typeof raw.name !== "string" || typeof raw.message !== "string") return { error: "rejected.error 需要 name/message" };
    return {
      result: {
        clientId,
        eventId,
        outcome: {
          kind: "rejected",
          error: {
            name: raw.name,
            message: raw.message,
            ...(typeof raw.code === "string" ? { code: raw.code } : {}),
            ...(raw.details === undefined ? {} : { details: raw.details }),
          },
        },
      },
    };
  }
  return { error: "outcome.kind 必须是 next/result/rejected" };
}

interface PendingWaterfall {
  eventId: string;
  event: string;
  agentId: string;
  settle: (outcome: DshWaterfallOutcome) => void;
}

/**
 * 一条连接代的 `$events` 状态：ready 一次性、emit 广播、waterfall 挂起与应答配对。
 * 生命周期与物理连接（`DshMuxSession`）一致，`dispose()` 时全部挂起请求按 `next` 收尾（让 owc 侧回落）。
 */
export class DshEventStream {
  readonly clientId = randomUUID();
  private ready = false;
  private readonly pending = new Map<string, PendingWaterfall>();
  private disposed = false;

  constructor(
    /** ready 帧的 host 事实（用于路径缩写展示）。 */
    private readonly home: string,
    /** 下行通道（mux 流的 item 帧）。 */
    private readonly deliver: (frame: DshEventDownlinkFrame) => void,
    /** 诊断日志（可选）。 */
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /** 发 ready 帧（每条连接只发一次；客户端把 ready 当作「连接代可用」的唯一信号）。 */
  start(): void {
    if (this.ready || this.disposed) return;
    this.ready = true;
    this.deliver({ type: "ready", clientId: this.clientId, host: { home: this.home } });
  }

  /** 广播一条 emit 帧（args 为事件参数数组，顺序与 dsh 事件声明一致）。 */
  emit(event: string, args: readonly unknown[] = []): void {
    if (this.disposed) return;
    this.deliver({ type: "emit", event, args });
  }

  /**
   * 发一条 waterfall 请求并登记挂起：`settle` 由 `$events/result` 或取消触发。
   * @returns eventId（同时用于 `cancel` 帧与结果匹配）。
   */
  request(event: string, agentId: string, request: Record<string, unknown>, settle: (outcome: DshWaterfallOutcome) => void): string {
    let eventId = randomUUID();
    while (this.pending.has(eventId)) eventId = randomUUID();
    this.pending.set(eventId, { eventId, event, agentId, settle });
    this.deliver({ type: "waterfall", event, eventId, agentId, request });
    return eventId;
  }

  /** 作废一条挂起请求（通知客户端并让 owc 侧回落）。 */
  cancel(eventId: string, reason = "取消"): void {
    const entry = this.pending.get(eventId);
    if (entry === undefined) return;
    this.pending.delete(eventId);
    this.deliver({ type: "cancel", eventId });
    entry.settle({ kind: "rejected", error: { name: "CancelledError", message: reason } });
  }

  /** 处理 `$events/result`：clientId 不匹配视为非本连接代（返回 false，调用方按未找到处理）。 */
  resolveResult(result: DshEventResult): boolean {
    if (result.clientId !== this.clientId) return false;
    const entry = this.pending.get(result.eventId);
    if (entry === undefined) {
      this.warn(`$events/result 指向未知 eventId：${result.eventId}`);
      return true;
    }
    this.pending.delete(result.eventId);
    entry.settle(result.outcome);
    return true;
  }

  /** 挂起请求数（测试与诊断用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 连接断开/流关闭：作废全部挂起请求（owc 侧按 `next` 回落，不误判为拒绝）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.pending.values()]) entry.settle({ kind: "next" });
    this.pending.clear();
  }
}
