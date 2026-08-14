import { useSyncExternalStore } from "react";

/**
 * 流式缓冲（框架无关版）：WS token delta 往往是很小的分片，逐片进 React 状态会
 * 每个 token 一次整页渲染。delta 缓冲在 React 之外，每个动画帧最多提交一次；
 * 无 rAF 的环境（测试/SSR）退化为 80ms 定时器。
 *
 * text/thinking 按字符预算逐帧平滑放出（积压自适应加速追平）；tool 参数增量实时放出。
 * 已提交块保持 append-only：每帧只追加入帧分片，不再复制累计全串（O(n²) 分配 churn 的旧坑）。
 *
 * 语义与旧 use-stream-buffers 一致，API 改为 subscribe/getSnapshot 以脱离 React 单测。
 */

export interface StreamBlock {
  /** 会话内稳定 id（text/thinking 段按创建序编号；tool 用工具调用 id） */
  id: string;
  kind: "text" | "thinking" | "tool";
  /** text/thinking：已平滑放出的分片；tool：参数 JSON 增量分片（实时，不平滑） */
  parts: string[];
  name?: string;
}

/** 平滑放出：每帧基线字符数（打字机感的下限节奏） */
const RELEASE_BASE_CHARS = 3;
/** 平滑放出：积压追平目标帧数（积压越大每帧放出越多，约 N 帧内追平） */
const RELEASE_CATCHUP_FRAMES = 8;

/** 每帧放出的字符预算：max(基线, 积压/追平帧数)，随积压自适应加速 */
export function releaseBudget(backlog: number): number {
  return Math.min(backlog, Math.max(RELEASE_BASE_CHARS, Math.ceil(backlog / RELEASE_CATCHUP_FRAMES)));
}

/** 会话的未提交流式模型（React 之外；committed 标记该块是否已进入提交区） */
interface PendingBlock {
  id: string;
  kind: "text" | "thinking" | "tool";
  name?: string;
  /** text/thinking：未放出的原始文本（slice 消费，稳态下有界） */
  backlog: string;
  /** tool：未提交的参数分片 */
  parts: string[];
  committed: boolean;
}

interface StreamBufferEnv {
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface StreamBuffer {
  /** 已提交的有序流式块（无内容时返回共享空数组，引用稳定） */
  blocksFor(sessionId: string): StreamBlock[];
  /** 每次提交后通知（useSyncExternalStore 的 subscribe） */
  subscribe(listener: () => void): () => void;
  /** 追加一个 token delta；同一帧内的多个 delta 只提交一次 */
  queueDelta(sessionId: string, text: string, thinking?: boolean): void;
  /** 追加一个工具调用参数分片；与 token delta 同一合批帧提交（不平滑，实时放出） */
  queueToolCallDelta(sessionId: string, id: string, name: string | undefined, text: string): void;
  /** 按平滑预算提交一帧（积压未放完会自动续帧） */
  flush(): void;
  /** 取消挂起的合批帧并立即全量提交（卸载/断线/run 结束前调用，避免丢尾部 token） */
  finish(): void;
  /** run 结束且历史消息重新拉取后 / stream_reset 时，清空该会话的临时流（含未放出积压） */
  clear(sessionId: string): void;
  /** 会话删除时丢弃其已提交状态与未提交缓冲 */
  discard(sessionId: string): void;
}

/** 无流式内容时的共享空数组（引用稳定，订阅组件不抖动） */
const EMPTY_BLOCKS: StreamBlock[] = [];

export function createStreamBuffer(env: StreamBufferEnv = {}): StreamBuffer {
  const scheduleFrame = env.scheduleFrame ?? ((callback: () => void): number =>
    typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 80));
  const cancelFrame = env.cancelFrame ?? ((handle: number): void => {
    if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
  });

  const committed = new Map<string, StreamBlock[]>();
  const pending: Record<string, { blocks: PendingBlock[] }> = {};
  const listeners = new Set<() => void>();
  let flushHandle: number | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** 提交一帧：先在 pending 模型上计算本帧放出量，再合并进提交区；text/thinking 有积压时自动续帧 */
  const flushFrame = (releaseAll: boolean): void => {
    flushHandle = undefined;
    let needMore = false;
    let touched = false;
    for (const [sessionId, session] of Object.entries(pending)) {
      let current = committed.get(sessionId);
      for (const block of session.blocks) {
        let chunk = "";
        if (block.kind === "tool") {
          chunk = block.parts.join("");
          block.parts = [];
          if (!chunk && block.committed) continue;
        } else {
          if (!block.backlog) continue;
          const budget = releaseAll ? block.backlog.length : releaseBudget(block.backlog.length);
          chunk = block.backlog.slice(0, budget);
          block.backlog = block.backlog.slice(budget);
          if (block.backlog) needMore = true;
        }
        block.committed = true;
        const index = (current ?? []).findIndex((item) => item.id === block.id);
        if (index >= 0) {
          if (!chunk) continue;
          const existing = current![index]!;
          current = [...current!.slice(0, index), { ...existing, parts: [...existing.parts, chunk] }, ...current!.slice(index + 1)];
        } else {
          current = [
            ...(current ?? []),
            {
              id: block.id,
              kind: block.kind,
              parts: chunk ? [chunk] : [],
              ...(block.name !== undefined ? { name: block.name } : {}),
            },
          ];
        }
        touched = true;
      }
      if (current) committed.set(sessionId, current);
    }
    if (touched) notify();
    if (needMore) schedule();
  };

  const schedule = (): void => {
    if (flushHandle !== undefined) return;
    flushHandle = scheduleFrame(() => flushFrame(false));
  };

  const cancelScheduled = (): void => {
    if (flushHandle === undefined) return;
    cancelFrame(flushHandle);
    flushHandle = undefined;
  };

  return {
    blocksFor(sessionId) {
      return committed.get(sessionId) ?? EMPTY_BLOCKS;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    queueDelta(sessionId, text, thinking = false) {
      if (!text) return;
      const session = (pending[sessionId] ??= { blocks: [] });
      const kind = thinking ? "thinking" : "text";
      const last = session.blocks.at(-1);
      // 与上一块同类则并入（保持段连续），否则按到达顺序开新段
      if (last && last.kind === kind) {
        last.backlog += text;
      } else {
        session.blocks.push({ id: `${kind}:${session.blocks.length}`, kind, backlog: text, parts: [], committed: false });
      }
      schedule();
    },
    queueToolCallDelta(sessionId, id, name, text) {
      const session = (pending[sessionId] ??= { blocks: [] });
      let block = session.blocks.find((item) => item.kind === "tool" && item.id === id);
      if (!block) {
        block = { id, kind: "tool", backlog: "", parts: [], committed: false };
        session.blocks.push(block);
      }
      if (name !== undefined) block.name = name;
      if (text) block.parts.push(text);
      schedule();
    },
    flush() {
      cancelScheduled();
      flushFrame(false);
    },
    finish() {
      cancelScheduled();
      flushFrame(true);
    },
    clear(sessionId) {
      delete pending[sessionId];
      committed.set(sessionId, []);
      notify();
    },
    discard(sessionId) {
      delete pending[sessionId];
      if (committed.delete(sessionId)) notify();
    },
  };
}

/** 应用级单例：事件路由与聊天视图共用 */
export const streamBuffer = createStreamBuffer();

/** React 绑定：订阅某会话的已提交流式块（引用稳定，无新内容不重渲染） */
export function useStreamBlocks(sessionId: string | undefined, buffer: StreamBuffer = streamBuffer): StreamBlock[] {
  return useSyncExternalStore(buffer.subscribe, () => buffer.blocksFor(sessionId ?? ""));
}
