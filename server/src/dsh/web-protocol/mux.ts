/**
 * dsh `/api/remote.mux` 逻辑流复用（M4 翻译层）。
 *
 * 一条物理 WebSocket 承载多条逻辑流：客户端 `open` / `cancel`，Host `item` / `error` / `end`。
 * 职责边界：本模块只管帧与流生命周期（含重复 streamId、协议违规、关闭时清理），
 * 具体端点实现由 {@link DshMuxEndpointHandler} 提供（会话投影、`$events` 等）。
 */
import { randomUUID } from "node:crypto";
import { parseMuxFrame, wireError, type DshMuxOutboundFrame, type DshWireError } from "./wire.js";

/** 协议违规/帧过大等关闭码（与 dsh 一致：1003 二进制、1008 形状非法）。 */
export const DSH_CLOSE_BINARY = 1003;
export const DSH_CLOSE_PROTOCOL = 1008;

/** 逻辑流的 Host 侧句柄（端点实现用它推送帧）。 */
export interface DshStreamHandle {
  readonly streamId: string;
  readonly endpoint: string;
  readonly args: Record<string, unknown>;
  /** 是否已取消（被客户端 cancel 或连接关闭）。 */
  readonly cancelled: boolean;
  /** 推送一条 item 帧（流已取消后为 no-op）。 */
  send(value: unknown): void;
  /** 推一条 error 帧并结束该流。 */
  fail(error: DshWireError): void;
  /** 结束该流（Host 主动 end）。 */
  end(): void;
  /** 注册取消回调（清理订阅/定时器）。 */
  onCancel(listener: () => void): void;
}

/** 端点实现：同步或异步建立流（返回后仍可通过句柄推送）。失败用 handle.fail。 */
export type DshMuxEndpointHandler = (handle: DshStreamHandle) => void | Promise<void>;

/** 端点解析：未知端点返回 undefined（Host 回 `gateway/method-unavailable`）。 */
export type DshMuxEndpointResolver = (endpoint: string) => DshMuxEndpointHandler | undefined;

/** 物理通道抽象（WS 适配层实现；便于单测）。 */
export interface DshMuxChannel {
  send(frame: DshMuxOutboundFrame): void;
  close(code: number, reason: string): void;
}

interface ActiveStream {
  handle: DshStreamHandle;
  cancelled: boolean;
  ended: boolean;
  cancelListeners: Set<() => void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** item 帧：值缺省（undefined）时省略 `value` 键（与上游 `JSON.stringify` 行为一致）。 */
function itemFrame(streamId: string, value: unknown): DshMuxOutboundFrame {
  return value === undefined ? { type: "item", streamId } : { type: "item", streamId, value };
}

/**
 * 一条连接的复用会话：客户端帧进、Host 帧出。
 * 不含心跳（由 WS 适配层负责 ping/pong 与超时断开）。
 */
export class DshMuxSession {
  private readonly active = new Map<string, ActiveStream>();
  private disposed = false;
  /** 连接代标识（`$events` ready 帧与 waterfall 应答回路都按 clientId 归属）。 */
  readonly clientId = randomUUID();

  constructor(
    private readonly channel: DshMuxChannel,
    private readonly resolveEndpoint: DshMuxEndpointResolver,
  ) {}

  /** 当前活跃逻辑流数（测试与诊断用）。 */
  get streamCount(): number {
    return this.active.size;
  }

  /** 处理一条文本帧；形状非法按协议违规关闭物理连接。 */
  handleText(raw: string): void {
    if (this.disposed) return;
    const frame = parseMuxFrame(raw);
    if (frame === undefined) {
      this.channel.close(DSH_CLOSE_PROTOCOL, "invalid stream frame");
      return;
    }
    if (frame.type === "cancel") {
      this.cancel(frame.streamId);
      return;
    }
    this.open(frame.streamId, frame.endpoint, frame.args);
  }

  /** 二进制帧（dsh 用 `close(1003)` 拒绝）。 */
  handleBinary(): void {
    if (this.disposed) return;
    this.channel.close(DSH_CLOSE_BINARY, "binary frames are not supported");
  }

  /** 客户端取消一条逻辑流（幂等；未知 streamId 静默忽略）。 */
  cancel(streamId: string): void {
    const entry = this.active.get(streamId);
    if (entry === undefined) return;
    this.finish(entry, true);
  }

  /** 连接断开：取消全部逻辑流并触发清理回调。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.active.values()]) this.finish(entry, true);
    this.active.clear();
  }

  private open(streamId: string, endpoint: string, args: Record<string, unknown>): void {
    if (this.active.has(streamId)) {
      // 上游把重复 streamId 判为协议违规；这里如实回错但不牵连其它流（客户端不会并发同 id）。
      this.channel.send({ type: "error", streamId, error: wireError("gateway/bad-request", `streamId 重复：${streamId}`, { endpoint }) });
      return;
    }
    const handler = this.resolveEndpoint(endpoint);
    if (handler === undefined) {
      this.channel.send({ type: "error", streamId, error: wireError("gateway/method-unavailable", `未实现端点：${endpoint}`, { endpoint }) });
      return;
    }
    const entry: ActiveStream = {
      cancelled: false,
      ended: false,
      cancelListeners: new Set(),
      handle: {
        streamId,
        endpoint,
        args,
        get cancelled(): boolean {
          return entry.cancelled;
        },
        send: (value: unknown): void => {
          if (entry.cancelled || entry.ended) return;
          this.channel.send(itemFrame(streamId, value));
        },
        fail: (error: DshWireError): void => {
          if (entry.cancelled || entry.ended) return;
          entry.ended = true;
          this.channel.send({ type: "error", streamId, error });
          this.finish(entry, false);
        },
        end: (): void => {
          if (entry.cancelled || entry.ended) return;
          entry.ended = true;
          this.channel.send({ type: "end", streamId });
          this.finish(entry, false);
        },
        onCancel: (listener: () => void): void => {
          if (entry.cancelled) { listener(); return; }
          entry.cancelListeners.add(listener);
        },
      },
    };
    this.active.set(streamId, entry);
    let result: void | Promise<void>;
    try {
      result = handler(entry.handle);
    } catch (error) {
      entry.handle.fail(wireError("gateway/internal", error instanceof Error ? error.message : String(error), { endpoint }));
      return;
    }
    if (result instanceof Promise) {
      void result.catch((error: unknown) => {
        entry.handle.fail(wireError("gateway/internal", error instanceof Error ? error.message : String(error), { endpoint }));
      });
    }
  }

  /** 收尾一条流：取消或正常结束都从表中移除并触发清理回调（幂等）。 */
  private finish(entry: ActiveStream, cancelled: boolean): void {
    if (entry.cancelled) return;
    entry.cancelled = cancelled;
    this.active.delete(entry.handle.streamId);
    for (const listener of [...entry.cancelListeners]) {
      try {
        listener();
      } catch {
        // 清理回调失败不影响其它流（单流故障隔离）
      }
    }
    entry.cancelListeners.clear();
  }
}

/** 便捷构造：由端点表（`Map<endpoint, handler>`）得到 resolver。 */
export function endpointResolver(handlers: ReadonlyMap<string, DshMuxEndpointHandler>): DshMuxEndpointResolver {
  return (endpoint) => handlers.get(endpoint);
}

/** 供测试/诊断：校验帧是否为本模块会发出的形状。 */
export function isOutboundFrame(value: unknown): value is DshMuxOutboundFrame {
  return isRecord(value) && (value.type === "item" || value.type === "error" || value.type === "end") && typeof value.streamId === "string";
}
