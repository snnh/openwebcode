import { useCallback, useRef, useState } from "react";

/**
 * 流式块：text/thinking/tool 按 delta 到达顺序排列（WS 事件天然有序，按到达序追加）。
 * parts 为 append-only 分片，消费方 join 后渲染；相邻 text/thinking 段会因中间插入其他块而分段。
 */
export interface StreamBlock {
  /** 会话内稳定 id（text/thinking 段按创建序编号；tool 用工具调用 id） */
  id: string;
  kind: "text" | "thinking" | "tool";
  /** text/thinking：已平滑放出的分片；tool：参数 JSON 增量分片（实时，不平滑） */
  parts: string[];
  name?: string;
}

export interface StreamBuffers {
  /** 已提交的有序流式块（按会话键控；append-only，块对象在无新内容时保持引用稳定） */
  blocks: Record<string, StreamBlock[]>;
  /** 追加一个 token delta；同一帧内的多个 delta 只提交一次状态 */
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

/** 平滑放出：每帧基线字符数（打字机感的下限节奏） */
const RELEASE_BASE_CHARS = 3;
/** 平滑放出：积压追平目标帧数（积压越大每帧放出越多，约 N 帧内追平） */
const RELEASE_CATCHUP_FRAMES = 8;

/** 每帧放出的字符预算：max(基线, 积压/追平帧数)，随积压自适应加速 */
export function releaseBudget(backlog: number): number {
  return Math.min(backlog, Math.max(RELEASE_BASE_CHARS, Math.ceil(backlog / RELEASE_CATCHUP_FRAMES)));
}

/** 会话的未提交流式模型（React 之外的 ref；committed 标记该块是否已进入状态） */
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

interface PendingSession {
  blocks: PendingBlock[];
}

/**
 * WebSocket 的 token delta 往往是很小的分片，逐片进 React 状态会导致每个 token
 * 一次整页渲染。这里把 delta 缓冲在 React 之外，每个动画帧最多提交一次；
 * 无 rAF 的环境（测试/SSR）退化为 80ms 定时器。
 * text/thinking 按字符预算逐帧平滑放出（积压自适应加速追平）；tool 参数增量实时放出。
 * 状态保持 append-only：每帧只追加入帧分片，不再复制累计全串
 * （旧实现每帧 `${prev}${delta}` 全量拷贝，长流下是 O(n²) 的分配 churn）。
 */
export function useStreamBuffers(): StreamBuffers {
  const [blocks, setBlocks] = useState<Record<string, StreamBlock[]>>({});
  const pending = useRef<Record<string, PendingSession>>({});
  const flushHandle = useRef<number | undefined>(undefined);

  /**
   * 提交一帧：先在 ref 模型上计算本帧放出量（setState updater 保持纯净，StrictMode 双调用安全），
   * 再合并进状态；text/thinking 有积压时自动续帧。
   */
  const flushFrame = useCallback((releaseAll: boolean): void => {
    flushHandle.current = undefined;
    let needMore = false;
    const releases: Array<{ sessionId: string; block: PendingBlock; chunk: string }> = [];
    for (const [sessionId, session] of Object.entries(pending.current)) {
      for (const block of session.blocks) {
        let chunk = "";
        if (block.kind === "tool") {
          // 工具参数增量不平滑：本帧全部提交
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
        releases.push({ sessionId, block, chunk });
      }
    }
    if (releases.length > 0) {
      setBlocks((previous) => {
        const next = { ...previous };
        for (const { sessionId, block, chunk } of releases) {
          const current = next[sessionId] ?? [];
          const index = current.findIndex((item) => item.id === block.id);
          if (index >= 0) {
            if (!chunk) continue;
            const existing = current[index]!;
            const updated: StreamBlock = { ...existing, parts: [...existing.parts, chunk] };
            next[sessionId] = [...current.slice(0, index), updated, ...current.slice(index + 1)];
          } else {
            next[sessionId] = [
              ...current,
              {
                id: block.id,
                kind: block.kind,
                parts: chunk ? [chunk] : [],
                ...(block.name !== undefined ? { name: block.name } : {}),
              },
            ];
          }
        }
        return next;
      });
    }
    if (needMore) scheduleFrame();
    // scheduleFrame 在下方定义：此处仅延迟到帧回调执行时引用，引用稳定（deps 均为稳定 useCallback）
  }, []);

  const scheduleFrame = useCallback((): void => {
    if (flushHandle.current !== undefined) return;
    flushHandle.current = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(() => flushFrame(false))
      : window.setTimeout(() => flushFrame(false), 80);
  }, [flushFrame]);

  const queueDelta = useCallback((sessionId: string, text: string, thinking = false): void => {
    if (!text) return;
    const session = (pending.current[sessionId] ??= { blocks: [] });
    const kind = thinking ? "thinking" : "text";
    const last = session.blocks.at(-1);
    // 与上一块同类则并入（保持段连续），否则按到达顺序开新段
    if (last && last.kind === kind) {
      last.backlog += text;
    } else {
      session.blocks.push({ id: `${kind}:${session.blocks.length}`, kind, backlog: text, parts: [], committed: false });
    }
    scheduleFrame();
  }, [scheduleFrame]);

  const queueToolCallDelta = useCallback((sessionId: string, id: string, name: string | undefined, text: string): void => {
    const session = (pending.current[sessionId] ??= { blocks: [] });
    let block = session.blocks.find((item) => item.kind === "tool" && item.id === id);
    if (!block) {
      block = { id, kind: "tool", backlog: "", parts: [], committed: false };
      session.blocks.push(block);
    }
    if (name !== undefined) block.name = name;
    if (text) block.parts.push(text);
    scheduleFrame();
  }, [scheduleFrame]);

  /** 取消挂起的合批帧（flush/finish 同步提交前共用，避免下一帧多一次空回调） */
  const cancelFrame = useCallback((): void => {
    if (flushHandle.current === undefined) return;
    if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(flushHandle.current);
    else window.clearTimeout(flushHandle.current);
  }, []);

  const flush = useCallback((): void => {
    cancelFrame();
    flushFrame(false);
  }, [cancelFrame, flushFrame]);

  const finish = useCallback((): void => {
    cancelFrame();
    flushFrame(true);
  }, [cancelFrame, flushFrame]);

  const clear = useCallback((sessionId: string): void => {
    delete pending.current[sessionId];
    setBlocks((value) => ({ ...value, [sessionId]: [] }));
  }, []);

  const discard = useCallback((sessionId: string): void => {
    delete pending.current[sessionId];
    setBlocks((previous) => {
      if (!(sessionId in previous)) return previous;
      const { [sessionId]: _removed, ...remaining } = previous;
      return remaining;
    });
  }, []);

  return { blocks, queueDelta, queueToolCallDelta, flush, finish, clear, discard };
}
