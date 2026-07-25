/**
 * 慢 WS 客户端背压阈值与判定。
 * 单客户端不得拖垮事件总线：待发字节或待发消息数任一超限即判定为慢客户端，
 * 由分发层先补发 resync.required 再断连（0.3.x §7.3 语义沿用）。
 */
export const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;
export const MAX_WS_BUFFERED_MESSAGES = 1_000;

export interface WsBackpressureLimits {
  maxBufferedBytes: number;
  maxBufferedMessages: number;
}

export const DEFAULT_WS_BACKPRESSURE_LIMITS: WsBackpressureLimits = {
  maxBufferedBytes: MAX_WS_BUFFERED_BYTES,
  maxBufferedMessages: MAX_WS_BUFFERED_MESSAGES,
};

/** 客户端发送缓冲快照：socket 内核缓冲字节数 + 已 send 未 flush 的消息条数。 */
export interface WsSendBuffer {
  readonly bufferedAmount: number;
  readonly pendingSends: number;
}

/** 任一维度超限即为慢客户端。 */
export function isSlowClient(
  client: WsSendBuffer,
  limits: WsBackpressureLimits = DEFAULT_WS_BACKPRESSURE_LIMITS,
): boolean {
  return client.bufferedAmount > limits.maxBufferedBytes || client.pendingSends > limits.maxBufferedMessages;
}
